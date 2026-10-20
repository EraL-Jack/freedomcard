import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { Server as IOServer, type Socket } from 'socket.io';

import * as core from '@app/core';
import {
  EchoSchema,
  IntentSchema,
  RoomCreateSchema,
  RoomJoinSchema,
  RoomReconnectSchema,
  RoomDeckSchema,
  ROOM_ERRORS,
  SOCKET_EVENTS,
  RECONNECT_GRACE_MS,
  TURN_TIMEOUT_MS,
  type Faction,
  type GameState,
  type EchoPayload,
  type Intent,
} from '@app/shared';

import { CARD_POOL } from './cards.js';
import {
  ReplayRecorder,
  RoomManager,
  SeqGuard,
  buildSnapshot,
  submitIntent,
  submitSystemIntent,
  type EnginePort,
  type PipelineOut,
  type ReplayRecord,
} from './room/index.js';
import type { Room } from './room/types.js';
import { TurnTimer, hostScheduler } from './room/turn-timer.js';
import { nextSeed, seedGameState, seedSetup } from './room/session.js';

/** 与 packages/server/package.json 的 version 保持一致。 */
const VERSION = '0.1.0';
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

/**
 * 生产形态下由服务端托管客户端构建产物（`SERVE_STATIC=1`）。
 * 开发态不启用 —— 那时由 Vite dev server 提供页面并代理 /health 与 /socket.io。
 */
const SERVE_STATIC = process.env.SERVE_STATIC === '1';
const CLIENT_DIST = fileURLToPath(new URL('../../client/dist', import.meta.url));

const fastify = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

fastify.get('/health', async () => ({ ok: true as const, version: VERSION }));

if (SERVE_STATIC) {
  const [{ default: fastifyStatic }, { readFile }] = await Promise.all([
    import('@fastify/static'),
    import('node:fs/promises'),
  ]);
  await fastify.register(fastifyStatic, { root: CLIENT_DIST, prefix: '/' });
  // SPA 回退：未命中的 GET 一律返回 index.html，交给前端路由。
  fastify.setNotFoundHandler(async (req, reply) => {
    if (req.method !== 'GET') {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }
    const html = await readFile(`${CLIENT_DIST}/index.html`);
    return reply.type('text/html').send(html);
  });
}

await fastify.listen({ port: PORT, host: HOST });

const io = new IOServer(fastify.server, {
  cors: { origin: true },
});

/** 会话层：房间 / 席位 / 去重 / 回放。ID 用 crypto，时钟用系统时间。 */
const roomManager = new RoomManager({
  clock: { now: () => Date.now() },
  ids: {
    id: () => randomUUID(),
    token: () => randomUUID(),
    code: () => Math.random().toString(36).slice(2, 8).toUpperCase(),
  },
});

/** 每间房一份对局运行时：状态、去重表、回放记录、广播序号、回合计时器。 */
interface RoomRuntime {
  state: GameState;
  guard: SeqGuard;
  replay: ReplayRecorder;
  serverSeq: number;
  /** 回合超时计时器 —— 由会话层驱动（ADR-0017），销毁房间时必须 `clear`。 */
  timer: TurnTimer;
  /**
   * 是否已用真实座位 / 卡组建立对局 —— ADR-0019。
   *
   * `runtimeOf` 惰性建立的是**空座位**状态（`seats: []`），它只用于「房间尚未开局」时
   * 让 Intent 有处可去（随后会被 `NOT_STARTED` / `INVALID_DECK` 拒绝）。
   * 真正开局后才置 `true`，并作为**幂等阀门**防止重复开局。
   */
  seeded: boolean;
}
const runtimes = new Map<string, RoomRuntime>();

/** 引擎端口实例 —— `core` 的公开签名与 `EnginePort` 结构一致，此处仅作显式绑定。 */
const engine: EnginePort = core;

function runtimeOf(roomId: string): RoomRuntime {
  let rt = runtimes.get(roomId);
  if (!rt) {
    // 空座位的初始状态：真正开局（洗牌 / 发牌 / 掷骰）由 `start_game` Intent 建立。
    // 卡组此刻尚未提交，故 `decks` 为空 —— 这不是占位偷懒，而是「卡组在开局时才进入状态」。
    const state = core.createInitialState({
      seed: nextSeed(),
      seats: [],
      decks: {},
      commanders: {},
    });
    // 两步构造：timer 的回调要闭包引用 `roomId`（而非 rt 本身），否则在 timer 先于
    // rt 存在时无法解析；先落对象再挂 timer 是最小的写法。
    rt = {
      state,
      guard: new SeqGuard(),
      replay: new ReplayRecorder(Date.now()),
      serverSeq: 0,
      seeded: false,
    } as RoomRuntime;
    rt.timer = new TurnTimer({
      now: () => Date.now(),
      scheduler: hostScheduler,
      // 测试可经环境变量放宽时限（与 GAME_SEED 同先例，ADR-0021）：全量并发下
      // 30s 墙钟可能被播放队列 + 慢速渲染吃掉，超时兜底会抢在测试动作前结束回合。
      // 生产不得设置。
      timeoutMs: Number(process.env['TURN_TIMEOUT_MS'] ?? TURN_TIMEOUT_MS),
      onTimeout: () => handleTurnTimeout(roomId),
    });
    runtimes.set(roomId, rt);
  }
  return rt;
}

function broadcastRoom(roomId: string): void {
  const room = roomManager.getRoom(roomId);
  if (room) io.to(roomId).emit(SOCKET_EVENTS.roomState, roomManager.publicView(room));
}

/**
 * 统一的对局事件广播出口。
 *
 * - 被**接受**的事件 → 广播给整个房间（双方都要看到同一串事件）；
 * - 被**拒绝 / 丢弃**的 → 只回给发起方，对手没有理由看到别人的非法操作。
 *
 * `socket` 缺省（系统 Intent 场景）时降级为广播 —— 系统 Intent 不会被拒绝，
 * 但保留该分支可避免万一被拒时事件凭空消失。
 */
function emitGameOut(roomId: string, rt: RoomRuntime, out: PipelineOut, socket?: Socket): void {
  rt.serverSeq += 1;
  const payload = { ...out, serverSeq: rt.serverSeq };
  if (out.kind === 'accepted' || !socket) {
    io.to(roomId).emit(SOCKET_EVENTS.gameEvents, payload);
  } else {
    socket.emit(SOCKET_EVENTS.gameEvents, payload);
  }
}

/**
 * 回合超时处理 —— ADR-0017。
 *
 * ⚠️ **超时不直接改状态**：构造一条 `actor: 'system'` 的 `turn:end` Intent，
 * 交给与玩家操作完全相同的处理链。绕过引擎直接改 `GameState` 会让服务端与客户端
 * 各 reduce 一次得到不同结果，`stateHash` 比对必然失败，且这种断裂只在联机时才暴露。
 *
 * ⚠️ **全程同步**：本函数由定时器直接驱动，内部不得出现 `await`（ADR-0011）。
 *
 * 超时后 `turn:end` 会把剩余的阶段逐个推进直到进入下一回合，故此处
 * 在确认未结束时重新 `arm`，为下一回合开始计时。
 */
function handleTurnTimeout(roomId: string): void {
  const rt = runtimes.get(roomId);
  const room = roomManager.getRoom(roomId);
  if (!rt || !room) return;
  if (room.phase !== 'playing' || gameOver(rt.state) || room.awaitingNext) return;

  const active = core.activePlayer(rt.state);
  if (!active) return;

  const intent: Intent = {
    type: core.INTENTS.turnEnd,
    actor: 'system',
    playerId: active,
    seq: rt.serverSeq + 1,
    reason: 'timeout',
  };

  const result = submitSystemIntent(rt.state, intent, {
    engine,
    replay: rt.replay,
    now: () => Date.now(),
    cards: CARD_POOL,
    emit: (out) => emitGameOut(roomId, rt, out),
  });
  rt.state = result.state;

  if (rt.state.winner !== null || rt.state.draw) {
    finishGame(roomId);
  } else {
    rt.timer.arm(); // 已进入下一回合 —— 重新计时
  }
  broadcastRoom(roomId);
}

/** 一小局是否已结束（血空 / 认输 / 40 轮判和）。 */
function gameOver(state: GameState): boolean {
  return state.winner !== null || state.draw;
}

/**
 * 一小局结束 —— 记分并决定是否进入下一小局（D-132 BO1/BO3）。
 *
 * BO3 未分胜负时房间仍留在 `playing`，但 `awaitingNext = true`：
 * 客户端据此显示「本局结束 + 比分 + 开始下一局」，房主点按钮后才开下一局。
 * 直接在服务端自动开局会让玩家来不及看清结算（Era 的「停顿一下」口径）。
 */
function finishGame(roomId: string): void {
  const rt = runtimes.get(roomId);
  const room = roomManager.getRoom(roomId);
  if (!rt || !room) return;
  rt.timer.clear();
  if (!gameOver(rt.state)) return;
  roomManager.recordGameResult(roomId, rt.state.winner);
  fastify.log.info(
    { roomId, winner: rt.state.winner, draw: rt.state.draw, gameNo: room.gameNo, format: room.format },
    '小局结束',
  );
  broadcastRoom(roomId);
}

/**
 * 建立对局 —— ADR-0019「开局桥」。
 *
 * 此前 `runtimeOf` 只能用 `seats: []` 建立**空座位**状态，于是 `startRule`
 * 的「开局需要 2 名玩家」校验必然拒绝，整条联机链路卡在最后一步。
 * 本函数负责把**房间层的座位事实**交给引擎，建立真实的 `GameState`。
 *
 * ⚠️ **开局仍走系统 Intent**（ADR-0011），不在这里直接调 `startRule`：
 * 洗牌 / 掷骰 / 发牌全部由引擎产出标准 `GameEvent[]`，客户端照常 `reduce`，
 * 不需要为「开局」写任何特例分支。
 *
 * ⚠️ **幂等**：`seeded` 只在这里置 true，重复触发不会二次开局。
 */
function startGame(roomId: string, opts: { firstPlayerId?: string } = {}): void {
  const rt = runtimes.get(roomId);
  const room = roomManager.getRoom(roomId);
  if (!rt || !room) return;
  // 允许两种入口：lobby 首次开局，以及 BO3 的「等待下一小局」。
  // 其它情况一律忽略 —— 重复 ready / 连点开始不能把对局重置。
  const isFirstGame = room.phase === 'lobby' && !rt.seeded;
  const isNextGame = room.awaitingNext;
  if (!isFirstGame && !isNextGame) return;

  const seats = room.seats.flatMap((s) => (s ? [s.playerId] : []));
  if (seats.length < 2) return;

  // 阵营（D-235）：建房 / 加入时选定，开局时装配对应的 30 张主卡组 + 指挥官。
  const factions: Record<string, Faction> = {};
  for (const s of room.seats) if (s) factions[s.playerId] = s.faction;

  // 自建卡组（D-141）：只覆盖主卡组，指挥官仍由阵营决定。
  // 入站时已用 `validateDeckList` 校验过，这里只做搬运。
  const customDecks: Record<string, readonly string[]> = {};
  for (const s of room.seats) if (s?.deck?.length) customDecks[s.playerId] = s.deck;

  // ① 先用真实座位 / 卡组建立「尚未开局」的初始状态，并作为快照下发给客户端。
  //
  //    ⚠️ 顺序不能反：`reduce` 是**增量**的，客户端必须先有起点状态，
  //    才能消化随后到来的开局事件。若先广播事件后发快照，开局那一批
  //    事件会被客户端丢弃（无从 reduce），表现为「开局日志凭空消失」。
  const prev = rt.state;
  const seedOpts = { seats, seed: nextSeed(), factions, decks: customDecks };
  // 回放（D-159）：把**装配参数**与开局哈希一起记下来 —— 只记 Intent 序列没法重放。
  const setup = seedSetup(seedOpts);
  rt.state = seedGameState(seedOpts);
  rt.replay.markStart(setup, core.stateHash(rt.state));
  broadcastSnapshot(roomId);

  // ② 开局仍走系统 Intent（ADR-0011）：洗牌 / 掷骰 / 发牌全部由引擎产出事件。
  const intent: Intent = {
    type: core.INTENTS.start,
    actor: 'system',
    playerId: seats[0]!,
    seq: rt.serverSeq + 1,
    reason: isNextGame ? 'next-game' : 'all-ready',
    // BO3：第 2 小局换先手，第 3 小局由上一小局败者先攻（docs/16 §1.3 / H33）；
    // 判和等无先手人选时不带该字段 = 按 seed 决定。
    ...(opts.firstPlayerId ? { payload: { firstPlayerId: opts.firstPlayerId } } : {}),
  };
  const result = submitSystemIntent(rt.state, intent, {
    engine,
    replay: rt.replay,
    now: () => Date.now(),
    cards: CARD_POOL,
    emit: (out) => emitGameOut(roomId, rt, out),
  });

  // ③ 引擎拒绝（如卡组构成不合法）→ 回滚并保持在 lobby，允许重新准备后重试。
  if (result.out.kind !== 'accepted') {
    rt.state = prev;
    const reason = result.out.kind === 'rejected' ? result.out.error.code : result.out.reason;
    fastify.log.warn({ roomId, reason }, '开局被引擎拒绝，房间保持 lobby');
    return;
  }

  rt.state = result.state;
  rt.seeded = true;
  room.phase = 'playing';
  roomManager.markNextGameStarted(roomId);
  // 记录本局先手（BO3 第 2 小局据此换人）
  const first = rt.state.seats[0];
  if (first) room.firstPlayers.push(first);
  // 新一局重新计时（上一局结束时已 clear）。
  rt.timer.arm();
  // 再发一次快照：这次才带上计时截止时刻（首次快照在 arm 之前，只能给 deadline = 0）。
  broadcastSnapshot(roomId);
  broadcastRoom(roomId);
}

/**
 * 广播对局快照 —— 客户端据此建立 `GameState` 起点。
 *
 * 为什么必须有这一步：`reduce` 是**增量**的，客户端拿到一串事件却无从 reduce
 * （没有起点状态）。开局 / 加入 / 重连三个入口都要下发。
 */
function broadcastSnapshot(roomId: string): void {
  const rt = runtimes.get(roomId);
  const room = roomManager.getRoom(roomId);
  if (!rt || !room) return;
  io.to(roomId).emit(SOCKET_EVENTS.gameSnapshot, snapshotOf(room, rt));
}

/**
 * 构造快照 —— B2-5 要求「回合数与计时居中显示」，故把**本回合的计时截止时刻**
 * 一并下发；未计时时为 `0`（客户端据此显示「—」）。
 *
 * ⚠️ 截止时刻来自服务端时钟（ADR-0017：会话层是唯一允许读时钟的地方），
 * 客户端不自行推算，避免两端时钟不同步时各说各话。
 */
function snapshotOf(room: Room, rt: RoomRuntime): Record<string, unknown> {
  const playerIds = room.seats.flatMap((s) => (s ? [s.playerId] : []));
  return {
    ...buildSnapshot(rt.state, rt.serverSeq, rt.guard, playerIds, core),
    turnDeadline: rt.timer.deadlineAt,
  };
}

/** 回放落盘目录（`app/replays`，已被 `.gitignore` 忽略）。 */
const REPLAY_DIR = fileURLToPath(new URL('../../../replays', import.meta.url));

/**
 * 写 `replay.json`。
 *
 * ⚠️ **异步，且严格在 Intent 处理链之外**（ADR-0011）：链上一旦出现 `await` 就会破坏原子性。
 * 因此记录阶段只在内存同步累积，落盘放到房间销毁时执行。
 */
async function flushReplay(roomId: string, record: ReplayRecord): Promise<void> {
  await mkdir(REPLAY_DIR, { recursive: true });
  const file = `${REPLAY_DIR}/${roomId}-${Date.now()}.json`;
  await writeFile(file, JSON.stringify(record, null, 2), 'utf8');
  fastify.log.info({ file }, '回放已落盘');
}

/** 房间已销毁的运行时：落盘回放后回收（同时清掉去重表与回合计时器）。 */
function sweepRuntimes(): void {
  for (const [roomId, rt] of runtimes) {
    if (roomManager.getRoom(roomId)) continue;
    runtimes.delete(roomId);
    // 不 clear 的话，定时器句柄会把已销毁房间的运行时吊住不释放。
    rt.timer.clear();
    // 没开过局的房间不落盘（D-177）—— 否则每间「建房后散了」的房间都会留一个空壳。
    if (!rt.replay.hasContent()) continue;
    // ⚠️ 必须 catch（D-176）：`void` 一个会 reject 的 Promise，在 Node 22 上等于
    // unhandled rejection → 默认**终止进程**。磁盘满、目录只读都会走到这条路径，
    // 而那时正是最不能挂的时候。回放丢了可以重打，服务挂了整间房都没了。
    void flushReplay(roomId, rt.replay.finish()).catch((err: unknown) => {
      fastify.log.error({ err, roomId }, '回放落盘失败（不影响对局，但这份记录已丢失）');
    });
  }
}

/** 定期回收超出保留窗口的断线席位；频率取窗口的一半，够用且开销可忽略。 */
const pruneTimer = setInterval(() => {
  const freed = roomManager.prune();
  for (const playerId of freed) {
    for (const rt of runtimes.values()) rt.guard.reset(playerId);
    fastify.log.info({ playerId }, '席位因超出保留窗口已释放');
  }
  sweepRuntimes();
}, RECONNECT_GRACE_MS / 2);

/** 优雅退出：停掉巡检定时器再关服务，避免进程被定时器吊住。 */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(pruneTimer);
    void fastify.close().then(() => process.exit(0));
  });
}

io.on('connection', (socket) => {
  fastify.log.info({ socketId: socket.id }, 'client connected');

  /** 建房：返回 playerId 与 token（客户端须自行保存，用于重连）。 */
  socket.on(SOCKET_EVENTS.roomCreate, (raw: unknown, ack?: (res: unknown) => void) => {
    const parsed = RoomCreateSchema.safeParse(raw);
    // ⚠️ 校验失败必须给玩家能看懂的话 —— 只回 INVALID_PAYLOAD 错误码，
    // 界面上就是一句天书（Era 2026-10-13 实测：人数填 22 超上限 8，
    // 只看到「操作失败：INVALID_PAYLOAD」，不知道哪里错了）。
    if (!parsed.success)
      return ack?.({
        ok: false,
        error: 'INVALID_PAYLOAD',
        message: '参数不合法：昵称需 1–24 个字，人数需 1–8 的整数',
      });
    const r = roomManager.create(parsed.data);    if (!r.ok) return ack?.({ ok: false, error: r.error, message: r.message });
    socket.data.playerId = r.value.seat.playerId;
    void socket.join(r.value.room.id);
    runtimeOf(r.value.room.id);
    broadcastRoom(r.value.room.id);
    ack?.({
      ok: true,
      room: roomManager.publicView(r.value.room),
      playerId: r.value.seat.playerId,
      token: r.value.seat.token,
      seat: r.value.seat.seat,
    });
  });

  socket.on(SOCKET_EVENTS.roomJoin, (raw: unknown, ack?: (res: unknown) => void) => {
    const parsed = RoomJoinSchema.safeParse(raw);
    if (!parsed.success)
      return ack?.({
        ok: false,
        error: 'INVALID_PAYLOAD',
        message: '参数不合法：房间码不能为空，昵称需 1–24 个字',
      });
    const r = roomManager.join(parsed.data);
    if (!r.ok) return ack?.({ ok: false, error: r.error, message: r.message });
    socket.data.playerId = r.value.seat.playerId;
    void socket.join(r.value.room.id);
    // 中途加入（有人离开后补位）时，对局可能已开始 —— 需要下发快照作为 reduce 起点。
    const rt = runtimeOf(r.value.room.id);
    const snapshot = rt.seeded ? snapshotOf(r.value.room, rt) : null;
    broadcastRoom(r.value.room.id);
    ack?.({
      ok: true,
      room: roomManager.publicView(r.value.room),
      playerId: r.value.seat.playerId,
      token: r.value.seat.token,
      seat: r.value.seat.seat,
      ...(snapshot ? { snapshot } : {}),
    });
  });

  /** 重连：校验凭据与保留窗口，返回 lastSeq 与完整快照。 */
  socket.on(SOCKET_EVENTS.roomReconnect, (raw: unknown, ack?: (res: unknown) => void) => {
    const parsed = RoomReconnectSchema.safeParse(raw);
    if (!parsed.success)
      return ack?.({ ok: false, error: 'INVALID_PAYLOAD', message: '重连参数不合法，请重新加入房间' });
    const r = roomManager.reconnect(parsed.data);
    if (!r.ok) return ack?.({ ok: false, error: r.error, message: r.message });
    socket.data.playerId = r.value.seat.playerId;
    void socket.join(r.value.room.id);
    const rt = runtimeOf(r.value.room.id);
    const snapshot = snapshotOf(r.value.room, rt);
    broadcastRoom(r.value.room.id);
    ack?.({ ok: true, room: roomManager.publicView(r.value.room), snapshot });
  });

  /**
   * 准备 / 开始游戏 —— B1 补充 3「双方加入并准备后即开始游戏」+ ADR-0019。
   *
   * 玩家只表达「我准备好了」；**座位顺序与随机种子由服务端决定**（ADR-0019 §1）——
   * 若让玩家一并提交，等于开放先后手伪造与牌序预测。
   */
  socket.on(SOCKET_EVENTS.roomReady, (_raw: unknown, ack?: (res: unknown) => void) => {
    const playerId = socket.data.playerId as string | undefined;
    if (!playerId) return ack?.({ ok: false, error: 'NOT_IN_ROOM' });

    const r = roomManager.setReady(playerId);
    if (!r.ok) return ack?.({ ok: false, error: r.error, message: r.message });

    const room = r.value.room;
    if (r.value.allReady) startGame(room.id);
    else broadcastRoom(room.id);

    ack?.({ ok: true, room: roomManager.publicView(room), started: r.value.allReady });
  });

  /**
   * 换卡组（D-141）—— **准备页**用，只在未开局时允许。
   *
   * 卡组只影响开局装配，局中状态不受影响，故这里不重发游戏快照，只广播房间视图。
   * 空数组 = 回到阵营默认卡组。
   */
  socket.on(SOCKET_EVENTS.roomDeck, (raw: unknown, ack?: (res: unknown) => void) => {
    const parsed = RoomDeckSchema.safeParse(raw);
    if (!parsed.success) {
      return ack?.({ ok: false, error: 'INVALID_PAYLOAD', message: '卡组参数不合法' });
    }
    const playerId = socket.data.playerId as string | undefined;
    if (!playerId) return ack?.({ ok: false, error: ROOM_ERRORS.NOT_IN_ROOM, message: '不在房间内' });
    const located = roomManager.locate(playerId);
    if (!located) return ack?.({ ok: false, error: ROOM_ERRORS.NOT_IN_ROOM, message: '不在房间内' });

    const r = roomManager.setDeck(located.room.id, playerId, parsed.data.deck);
    if (!r.ok) return ack?.({ ok: false, error: r.error, message: r.message });
    broadcastRoom(r.value.id);
    ack?.({ ok: true, room: roomManager.publicView(r.value) });
  });

  /**
   * 开始下一小局 —— BO3（D-132）。
   *
   * 只有**房主**能发起：两名玩家同时点会让开局链竞争，服务端无法区分「谁的意思」。
   * 先手由 `nextFirstPlayer` 决定（第 2 小局换人；第 3 小局由上一小局败者先攻，H33 / D-145）。
   */
  socket.on(SOCKET_EVENTS.roomNextGame, (_raw: unknown, ack?: (res: unknown) => void) => {
    const playerId = socket.data.playerId as string | undefined;
    if (!playerId) return ack?.({ ok: false, error: ROOM_ERRORS.NOT_IN_ROOM, message: '不在房间内' });

    const located = roomManager.locate(playerId);
    if (!located) return ack?.({ ok: false, error: ROOM_ERRORS.NOT_IN_ROOM, message: '不在房间内' });
    const room = located.room;
    if (room.hostId !== playerId) {
      return ack?.({ ok: false, error: ROOM_ERRORS.NOT_HOST, message: '只有房主能开始下一局' });
    }
    if (!room.awaitingNext) {
      return ack?.({
        ok: false,
        error: ROOM_ERRORS.NO_NEXT_GAME,
        message: '当前没有待开始的小局',
      });
    }
    // 有人已离开 → 席位不足 2，开不了下一局（正常流程下 leave 会先判负系列赛，
    // 这里再兜一层，避免出现「按钮可点但开局静默失败」）。
    if (room.seats.filter(Boolean).length < 2) {
      return ack?.({ ok: false, error: ROOM_ERRORS.ROOM_ENDED, message: '对手已离开，系列赛结束' });
    }

    startGame(room.id, { firstPlayerId: roomManager.nextFirstPlayer(room.id) ?? undefined });
    ack?.({ ok: true, room: roomManager.publicView(room) });
  });

  socket.on(SOCKET_EVENTS.roomLeave, (_raw: unknown, ack?: (res: unknown) => void) => {
    const playerId = socket.data.playerId as string | undefined;
    if (!playerId) return ack?.({ ok: false, error: 'NOT_IN_ROOM' });
    const before = roomManager.locate(playerId);
    const r = roomManager.leave(playerId);
    if (!r.ok) return ack?.({ ok: false, error: r.error, message: r.message });
    if (before) void socket.leave(before.room.id);

    // 对局进行中离场 = 系统代为认输（Era 2026-10-18：一方离开后另一方卡在空白页）。
    // 走系统 Intent 而非直接改状态 —— 结算仍由引擎产出标准 game:ended 事件，
    // 留下的玩家按正常事件流收到「对局结束」，不需要客户端特例。
    //
    // D-132：离场同时**判负整个系列赛** —— 否则 BO3 会停在「等待下一局」。
    if (before) {
      const rt = runtimes.get(before.room.id);
      if (rt && rt.state.started && rt.state.winner === null && playerId in rt.state.players) {
        const intent: Intent = {
          type: core.INTENTS.concede,
          actor: 'system',
          playerId,
          seq: rt.serverSeq + 1,
          reason: 'opponent-left',
        };
        const result = submitSystemIntent(rt.state, intent, {
          engine,
          replay: rt.replay,
          now: () => Date.now(),
          cards: CARD_POOL,
          emit: (out) => emitGameOut(before.room.id, rt, out),
        });
        rt.state = result.state;
        if (gameOver(rt.state)) {
          rt.timer.clear();
          roomManager.forfeitSeries(before.room.id, playerId);
        }
      } else if (rt && before.room.awaitingNext) {
        // 小局之间离开同样结束系列赛：否则留下的人卡在「等待房主开始下一局」。
        roomManager.forfeitSeries(before.room.id, playerId);
      }
    }

    if (r.value.room) broadcastRoom(r.value.room.id);
    else sweepRuntimes();
    ack?.({ ok: true });
  });

  /**
   * Intent 入站：走完整处理链（去重 → 引擎 → reduce → 哈希 → 回放 → 广播），全程同步。
   *
   * 规则由 `core/src/rules/` 的注册表按 `Intent.type` 派发（9 条规则，ADR-0024 起为 8 血版）；
   * 未知类型才返回 `NOT_IMPLEMENTED`。被拒绝时附中文 `message`，客户端直接展示。
   */
  socket.on(SOCKET_EVENTS.gameIntent, (raw: unknown, ack?: (res: unknown) => void) => {
    const parsed = IntentSchema.safeParse(raw);
    if (!parsed.success)
      return ack?.({ ok: false, error: 'INVALID_PAYLOAD', message: '操作参数不合法，请重试' });
    const intent = parsed.data as Intent;

    const located = roomManager.locate(intent.playerId);
    if (!located) return ack?.({ ok: false, error: 'NOT_IN_ROOM' });

    const rt = runtimeOf(located.room.id);
    const result = submitIntent(rt.state, intent, {
      engine,
      guard: rt.guard,
      replay: rt.replay,
      now: () => Date.now(),
      cards: CARD_POOL,
      emit: (out) => emitGameOut(located.room.id, rt, out, socket),
    });
    rt.state = result.state;

    // 只有**被接受**的操作才重新计时：被拒绝 / 重复的 Intent 不续命，
    // 否则发一串非法操作就能无限拖时间，超时保护当场失效（ADR-0017 §2）。
    if (result.out.kind === 'accepted') {
      if (gameOver(rt.state)) {
        finishGame(located.room.id);
      } else {
        rt.timer.arm();
      }
      broadcastRoom(located.room.id);
    }

    ack?.({ ok: result.out.kind === 'accepted', out: result.out });
  });

  socket.on(SOCKET_EVENTS.echo, (raw: unknown, ack?: (res: unknown) => void) => {
    // 运行时校验只发生在服务端入站处（ADR：客户端不引入 zod）。
    const parsed = EchoSchema.safeParse(raw);
    if (!parsed.success) {
      ack?.({ ok: false, error: 'INVALID_PAYLOAD' });
      return;
    }
    const payload: EchoPayload = parsed.data;
    ack?.({ ok: true, message: payload.message, at: Date.now() });
  });

  socket.on('disconnect', (reason) => {
    const playerId = socket.data.playerId as string | undefined;
    fastify.log.info({ socketId: socket.id, playerId, reason }, 'client disconnected');
    if (!playerId) return;
    // 断线保留席位（不立即释放）；到点由 prune 回收。
    roomManager.markDisconnected(playerId);
    const located = roomManager.locate(playerId);
    if (located) broadcastRoom(located.room.id);
  });
});

fastify.log.info({ port: PORT, host: HOST }, 'server ready');
