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
  MULLIGAN_WINDOW_MS,
  AI_PLAYER_ID,
  AI_STEP_DELAY_MS,
  type GameState,
  type EchoPayload,
  type Intent,
} from '@app/shared';

import { CARD_POOL, validateCardPool } from './cards.js';
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
import { makeRoomCode } from './room/code.js';
import { cacheControlFor, isSpaRoute } from './static-serve.js';
import { normalizePlayerIntent } from './room/inbound.js';
import { buildMulliganSkipIntent, mulliganWindowMs, pendingMulliganPlayers } from './room/mulligan-timeout.js';
import { WindowRateLimit } from './room/rate-limit.js';
import { sweepReplayDir } from './room/replay-maintenance.js';
import { TurnTimer, hostScheduler } from './room/turn-timer.js';
import { buildTimeoutIntent } from './room/timeout-intent.js';
import { nextSeed, seedGameState, seedSetup } from './room/session.js';

/** 与 packages/server/package.json 的 version 保持一致。 */
const VERSION = '0.1.0';
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

/**
 * 限流阈值（ADR-0039）。取「真人永远碰不到、脚本立刻撞墙」：
 * 真人建房一次几十秒，脚本是每秒数千次；真人点击上限约 5 次/秒。
 *
 * 全部可经环境变量覆盖，便于测试与临时放宽。
 */
const RL_CREATE_PER_MIN = Number(process.env.RL_CREATE_PER_MIN ?? 10);
const RL_JOIN_PER_MIN = Number(process.env.RL_JOIN_PER_MIN ?? 20);
const RL_INTENT_PER_SEC = Number(process.env.RL_INTENT_PER_SEC ?? 20);
const RL_MAX_ROOMS = Number(process.env.RL_MAX_ROOMS ?? 2000);
const RL_MAX_CONNECTIONS = Number(process.env.RL_MAX_CONNECTIONS ?? 5000);

/**
 * 回放保留策略（X-20 / ADR-0040）。
 *
 * 默认 7 天 + 500 MB：7 天足够复盘一周内的问题；500 MB 在 40 GB 小盘上无感，
 * 但能挡住「某天被刷出十万间房」的尖峰。
 */
const REPLAY_KEEP_DAYS = Number(process.env.REPLAY_KEEP_DAYS ?? 7);
const REPLAY_MAX_MB = Number(process.env.REPLAY_MAX_MB ?? 500);
/** 只算不删 —— 首次上线/调整阈值时先用它看报告。 */
const REPLAY_SWEEP_DRY_RUN = process.env.REPLAY_SWEEP_DRY_RUN === '1';

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
  await fastify.register(fastifyStatic, {
    root: CLIENT_DIST,
    prefix: '/',
    /*
     * 缓存策略（issue #107 / D-273）：带哈希的产物长缓存，index.html 不缓存。
     * 原来一律走默认的 `max-age=0`，于是每次打开都要重新校验 CSS 39 kB + JS 407 kB，
     * 穿过公网隧道多一次失败机会 —— 而样式表失败**不会重试、也不会报错**，
     * 页面静默变成白底黑字（Era 2026-10-21 手机端就是这样）。
     */
    setHeaders: (res, path) => {
      const cacheControl = cacheControlFor(path);
      if (cacheControl) res.header('cache-control', cacheControl);
    },
  });
  /*
   * SPA 回退：**只有像前端路由的路径**才回 index.html（issue #107）。
   *
   * 原来对「所有未命中的 GET」都回 index.html —— 缺一个 `index-*.css` 就变成
   * 「HTML 冒充 CSS」：200 + `content-type: text/html`，浏览器按 MIME 拒绝解析，
   * 页面无样式且控制台无报错。资源缺失就该 404。
   */
  fastify.setNotFoundHandler(async (req, reply) => {
    if (req.method !== 'GET' || !isSpaRoute(req.url)) {
      return reply.code(404).type('application/json').send({ error: 'NOT_FOUND' });
    }
    const html = await readFile(`${CLIENT_DIST}/index.html`);
    // index.html 决定加载哪个哈希包 —— 被缓存住等于发版后还跑旧包
    return reply.type('text/html').header('cache-control', 'no-cache').send(html);
  });
}

await fastify.listen({ port: PORT, host: HOST });

// 卡池数值自检（P-07 / D-240）—— 放在 listen 之后是为了让它进日志：
// 负数 / 小数的伤害不会在结算时报错，只会静默算出「打脸加血」这类怪结果，
// 所以宁可在启动时就把进程打死，也不要带着脏数据接客。
{
  const poolIssue = validateCardPool();
  if (poolIssue) {
    fastify.log.error({ poolIssue }, '卡池数据非法，拒绝继续');
    throw new Error(`卡池数据非法：${poolIssue}`);
  }
}

const io = new IOServer(fastify.server, {
  cors: { origin: true },
});

/** 会话层：房间 / 席位 / 去重 / 回放。ID 用 crypto，时钟用系统时间。 */
const roomManager = new RoomManager({
  clock: { now: () => Date.now() },
  ids: {
    id: () => randomUUID(),
    token: () => randomUUID(),
    code: () => makeRoomCode(),
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
  /**
   * 开局换牌阶段的超时句柄（D-259）。
   *
   * 换牌是**开局前**的阶段，不属于任何回合，所以不能借 `timer`（它会在超时时发
   * `turn:end`）—— 那会让「还没开局」直接跳到下一回合。这里单独一个句柄，
   * 到点做的事是「替还没确认的人提交跳过」。
   */
  mulliganHandle: unknown | null;
  /**
   * 换牌阶段的截止时刻（D-267）—— 客户端据此显示桌面倒计时。
   *
   * 原来换牌阶段没有对外暴露任何截止时刻，`snapshot.turnDeadline` 取的是回合计时器
   * 的 `deadlineAt`，而换牌时该计时器是 `clear` 状态（值为 0）→ 顶栏「计时 —」。
   * Era 2026-10-21 issue #99：「倒计时要显示在桌面上，目前看倒计时是 -」。
   *
   * `0` = 没在计时（未开局 / 已进入回合阶段）。
   */
  mulliganDeadline: number;
}
const runtimes = new Map<string, RoomRuntime>();

/** 引擎端口实例 —— `core` 的公开签名与 `EnginePort` 结构一致，此处仅作显式绑定。 */
const engine: EnginePort = core;

/**
 * 本房间该用多长的回合时限（H18）。
 *
 * 优先级：**环境变量 > 房间设置 > 默认值**。
 *
 * 环境变量留最前，是因为它唯一的用途是测试放宽（全量并发下 30~60s 墙钟可能被
 * 播放队列 + 慢速渲染吃掉，超时兜底会抢在测试动作前结束回合）；生产不得设置。
 */
function resolveTurnTimeout(roomId: string): number {
  const env = Number(process.env['TURN_TIMEOUT_MS'] ?? '');
  if (Number.isFinite(env) && env > 0) return env;
  return roomManager.getRoom(roomId)?.turnTimeoutMs ?? TURN_TIMEOUT_MS;
}

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
      mulliganHandle: null,
      mulliganDeadline: 0,
    } as RoomRuntime;
    rt.timer = new TurnTimer({
      now: () => Date.now(),
      scheduler: hostScheduler,
      // 测试可经环境变量放宽时限（与 GAME_SEED 同先例，ADR-0021）；否则按建房选的档位
      // （H18：30 / 60 / 180 / 999 秒）。生产不得设置该环境变量。
      timeoutMs: resolveTurnTimeout(roomId),
      onTimeout: () => handleTurnTimeout(roomId),
    });
    runtimes.set(roomId, rt);
  }
  return rt;
}

/** 清掉换牌超时句柄。未计时时为空操作。 */
function clearMulliganTimer(rt: RoomRuntime): void {
  if (rt.mulliganHandle !== null) {
    hostScheduler.clearTimeout(rt.mulliganHandle);
    rt.mulliganHandle = null;
  }
  // 截止时刻与句柄同生共死：句柄没了还留着日期，客户端会显示一个永远不动的倒计时。
  rt.mulliganDeadline = 0;
}

/**
 * 换牌阶段超时兜底（D-259 / D-267）。
 *
 * 换牌是**开局前**的阶段，不属于任何回合，所以不能借「回合超时」（那会发 `turn:end`
 * 把还没开始的对局直接推进）。到期做的事只有一件：**替还没确认的人提交「跳过」**。
 *
 * ⚠️ **D-267**：这条 Intent 原来漏了 `payload.returns`，被 `mulliganRule` 以
 * 「returns 必须是 uid 数组」拒掉 —— 兜底失效、阶段关不掉，而且 system Intent
 * 没有 socket，拒绝被**广播给全房**，Era 因此在手机上看到那句英文（issue #99）。
 * 现在 Intent 由 `buildMulliganSkipIntent` 构造并有单测钉住 payload。
 */
function handleMulliganTimeout(roomId: string): void {
  const rt = runtimes.get(roomId);
  const room = roomManager.getRoom(roomId);
  if (!rt || !room || room.phase !== 'playing') return;
  if (rt.state.phase !== 'mulligan') return;

  /*
   * 每提交一次就重算「还有谁没确认」——前一个人的「跳过」可能已经关闭了阶段
   * （对方早就确认过）。因此不能一次性取快照再逐个提交。
   */
  for (;;) {
    const pending = pendingMulliganPlayers(rt.state);
    const pid = pending[0];
    if (pid === undefined) break;
    // 阶段被上一次提交关掉了 —— `pendingMulliganPlayers` 会返回空，循环自然结束。
    if (rt.state.phase !== 'mulligan') break;
    const result = submitSystemIntent(rt.state, buildMulliganSkipIntent(pid, rt.serverSeq), {
      engine,
      replay: rt.replay,
      now: () => Date.now(),
      cards: CARD_POOL,
      emit: (out) => emitGameOut(roomId, rt, out),
    });
    rt.state = result.state;
    /*
     * 提交被拒就退出循环。不收手会是**死循环**：状态没变，`pending` 每一轮都返回同一批人。
     * 拒绝原因已经在 `emitGameOut` 里记了日志（D-267 起 system 拒绝不再广播给玩家）。
     */
    if (result.out.kind !== 'accepted') break;
  }

  // 「跳过」提交完必然关闭阶段 → 进入第一回合，从这里开始算回合时限。
  if (rt.state.phase !== 'mulligan') {
    clearMulliganTimer(rt);
    rt.timer.arm();
  }
  broadcastRoom(roomId);
  scheduleAi(roomId);
  // 关掉了阶段要补一次快照：客户端靠 `turnDeadline` 显示倒计时，
  // 不刷新就会一直停在换牌阶段那个已经过期的截止时刻上。
  broadcastSnapshot(roomId);
}

/** 开始换牌倒计时。已在计时时不重置 —— 一次「确认」不该给另一个人续命。 */
function armMulliganTimer(roomId: string, rt: RoomRuntime): void {
  if (rt.mulliganHandle !== null) return;
  /*
   * 窗口跟随**房间的回合时限**（D-267 / issue #99）。优先级与回合计时器完全一致
   * （env > 房间档位 > 默认），否则测试里两个时限会打架：换牌 120s、回合 30s。
   */
  const windowMs = mulliganWindowMs(resolveTurnTimeout(roomId), MULLIGAN_WINDOW_MS);
  // 先落截止时刻再挂句柄：快照随时可能被广播，不能让客户端读到「有句柄没日期」的中间态。
  rt.mulliganDeadline = Date.now() + windowMs;
  rt.mulliganHandle = hostScheduler.setTimeout(() => {
    rt.mulliganHandle = null;
    handleMulliganTimeout(roomId);
  }, windowMs);
}

/**
 * 按当前阶段选计时器（D-259 / D-267）。
 *
 * 换牌阶段与回合是**两套**计时：前者时长**跟随房间的回合时限**（D-267 之前写死 30s，
 * 与建房选的档位矛盾）、超时做「跳过」；后者也按同一档位（H18）、超时做「结束回合」。
 * 共用一个 handle 会让换牌阶段被当成一个回合提前结束。
 */
function syncTimers(roomId: string, rt: RoomRuntime): void {
  if (rt.state.phase === 'mulligan') {
    rt.timer.clear();
    armMulliganTimer(roomId, rt);
    return;
  }
  clearMulliganTimer(rt);
  rt.timer.arm();
}

function broadcastRoom(roomId: string): void {
  const room = roomManager.getRoom(roomId);
  if (room) io.to(roomId).emit(SOCKET_EVENTS.roomState, roomManager.publicView(room));
}

/**
 * 一条连接只能占一个席位（D-181）。
 *
 * 建房 / 加入 / 重连都会写 `socket.data.playerId`，**覆盖前必须先把旧席位放掉**。
 * 不释放的后果不是「留下一个空房间」那么简单：
 *
 * - 旧席位仍是 `connected: true`，而 `prune()` 只回收 `connected: false` 的席位
 *   （那条契约本身是对的 —— 断线有 `RECONNECT_GRACE` 的保留窗口）；
 * - 于是旧房间连同它的运行时（回合计时器、SeqGuard、ReplayRecorder）**永不释放**；
 * - 实测：单条连接 0.3ms 就能建一间房，2000 间约涨 17 MB —— 挂机脚本一两分钟就能把进程撑爆。
 *
 * 2026-10-20 实测复现：单连接建 2000 间后断开，只有最后那间被回收，其余全部滞留。
 */
function releaseSeatOf(socket: Socket): void {
  const prev = socket.data.playerId as string | undefined;
  socket.data.playerId = undefined;
  if (!prev) return;
  // 退出 socket.io 的房间频道 —— 房间若还在（还有别人），别让这条连接继续收它的事件。
  const located = roomManager.locate(prev);
  if (located) void socket.leave(located.room.id);
  const r = roomManager.leave(prev);
  // 旧房间可能因这次离开而销毁（room 为 null），那就没有可广播的对象。
  if (r.ok && r.value.room) broadcastRoom(r.value.room.id);
}

/**
 * 席位作废后的收尾 —— **主动离开**与**断线宽限到期**共用（D-233）。
 *
 * - 对局进行中：系统代认输（引擎产出标准 `game:ended`，留下的玩家按正常事件流收到结束，
 *   客户端不需要特例）；随后判负整个系列赛，否则 BO3 会停在「等待下一局」。
 * - 局间（`awaitingNext`）：直接判负系列赛。
 *
 * ⚠️ 两条路径必须同一口径。此前只有 `roomLeave` 收尾，断线宽限到期仅释放席位 ——
 * 留下的一方会对着一个永远不动的对手继续打，最长拖到 40 轮判和（AR-23 / PM-03）。
 */
function abandonSeat(roomId: string, playerId: string): void {
  const rt = runtimes.get(roomId);
  if (!rt) return;
  if (rt.state.started && rt.state.winner === null && playerId in rt.state.players) {
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
      emit: (out) => emitGameOut(roomId, rt, out),
    });
    rt.state = result.state;
    if (gameOver(rt.state)) {
      rt.timer.clear();
      clearMulliganTimer(rt);
      roomManager.forfeitSeries(roomId, playerId);
    }
    return;
  }
  const room = roomManager.getRoom(roomId);
  if (room?.awaitingNext) roomManager.forfeitSeries(roomId, playerId);
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
  if (out.kind === 'accepted') {
    io.to(roomId).emit(SOCKET_EVENTS.gameEvents, payload);
    return;
  }
  if (socket) {
    // 玩家自己的操作被拒 → 只回给他（不打扰对手）
    socket.emit(SOCKET_EVENTS.gameEvents, payload);
    return;
  }
  /*
   * **system Intent 被拒 → 不广播**（D-267）。
   *
   * 原来这里和「接受」走同一条广播分支，于是引擎对系统 Intent 的拒绝原因会直接
   * 弹到每个玩家屏幕上。issue #99 就是实例：换牌超时兜底漏了 `payload.returns`，
   * 引擎回「returns 必须是 uid 数组」—— 一句内部契约文案，玩家既看不懂也不知道该怎么办，
   * 更糟的是它会让人以为是**自己的操作**被拒了。
   *
   * 系统 Intent 由服务端自己发起，被拒是**服务端 bug**，应该进日志让开发者看见，
   * 而不是推给玩家。玩家的界面只该看到「阶段真的推进了」。
   */
  fastify.log.warn(
    { roomId, kind: out.kind, error: 'error' in out ? out.error : out.reason },
    '系统 Intent 未被接受（不广播给玩家）',
  );
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

  // 构造交给纯函数（T-05）：那段逻辑抽出去之后才能单测。
  // 无行动方（未开局 / 已结束）时返回 null —— 同样的情况上面已经挡过一遍。
  const intent = buildTimeoutIntent(rt.state, rt.serverSeq);
  if (!intent) return;

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
    // 已进入下一回合 —— 重新计时（D-259 起统一走 syncTimers：AI 若刚在换牌阶段，
    // 这里也要能正确切到回合计时）。
    syncTimers(roomId, rt);
  }
  broadcastRoom(roomId);
  // 超时是把回合交给下一个人，人机房里可能正好轮到 AI（D-242）。
  scheduleAi(roomId);
}

/* ------------------------------ 人机对战（D-242） ------------------------------ */

/**
 * 每个房间最多一个待执行的 AI 定时器 —— 「已排队」的标记本身就是去重。
 *
 * 为什么必须有去重：玩家每操作一次都会 `scheduleAi`，而 AI 自己每动一手也会再排一拍。
 * 不去重就会在同一时刻堆出多个定时器，AI 一步接一步地瞬间打完整回合，
 * 玩家只看到事件齐刷刷蹦出来，既看不清也失去了「对面在思考」的反馈。
 */
const aiTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 现在是否轮到 AI（含「受伤展示把待定选择挂给 AI」这种非行动方场景）。 */
function aiToMove(state: GameState): boolean {
  if (!state.started || state.winner !== null || state.draw) return false;
  if (state.pendingChoice) return state.pendingChoice.playerId === AI_PLAYER_ID;
  /*
   * D-262：换牌阶段是**双方同时**的，`activeSeat` 还指着先攻方，不能拿它判断。
   *
   * 若这里仍按 `seats[activeSeat]` 判，玩家先手时 AI 永远不会提交，
   * 玩家只能干等 30 秒换牌超时兜底（人机局第一分钟就卡住不动）。
   */
  if (state.phase === 'mulligan') return state.players[AI_PLAYER_ID]?.mulliganDone !== true;
  return state.seats[state.activeSeat] === AI_PLAYER_ID;
}

/** 若轮到 AI，安排下一拍；不是 AI 的场合直接返回（不排空转的定时器）。 */
function scheduleAi(roomId: string): void {
  const rt = runtimes.get(roomId);
  const room = roomManager.getRoom(roomId);
  if (!rt || !room) return;
  if (room.phase !== 'playing' || room.awaitingNext) return;
  if (!room.seats.some((s) => s?.playerId === AI_PLAYER_ID)) return;
  if (!aiToMove(rt.state)) return;
  if (aiTimers.has(roomId)) return;
  const timer = setTimeout(() => {
    aiTimers.delete(roomId);
    runAiStep(roomId);
  }, AI_STEP_DELAY_MS);
  // 不阻止进程退出 —— 服务端关停时不必等 AI 这一拍跑完。
  timer.unref?.();
  aiTimers.set(roomId, timer);
}

/**
 * AI 走一拍。
 *
 * 与真人**完全同一条链路**（`submitSystemIntent` → 引擎 → 事件广播 → 回放记录），
 * 区别只有两处：`actor: 'system'`（AI 不是 socket 客户端）、`reason: 'ai'`（日志可辨）。
 *
 * ⚠️ **被拒必须兜底**：AI 的启发式不保证每一步都合法（例如某张法术当前找不到合法目标）。
 * 原地重试会让同一拍无限发出同一条必被拒的 Intent，对局就停死在那里。
 * 所以一旦被拒就直接推进阶段 —— 宁可少打一张牌，也不能让玩家干等。
 */
function runAiStep(roomId: string): void {
  const rt = runtimes.get(roomId);
  const room = roomManager.getRoom(roomId);
  if (!rt || !room || room.phase !== 'playing' || room.awaitingNext) return;
  if (gameOver(rt.state)) return;

  const move = core.decideAiMove(rt.state, AI_PLAYER_ID, CARD_POOL, Date.now());
  if (!move) return;

  const fire = (type: string, payload?: Record<string, unknown>) => {
    const intent: Intent = {
      type,
      actor: 'system',
      playerId: AI_PLAYER_ID,
      seq: rt.serverSeq + 1,
      reason: 'ai',
      ...(payload ? { payload } : {}),
    };
    return submitSystemIntent(rt.state, intent, {
      engine,
      replay: rt.replay,
      now: () => Date.now(),
      cards: CARD_POOL,
      emit: (out) => emitGameOut(roomId, rt, out),
    });
  };

  let result = fire(move.type, move.payload);
  if (result.out.kind !== 'accepted') {
    fastify.log.warn(
      {
        roomId,
        type: move.type,
        reason: result.out.kind === 'rejected' ? result.out.error.code : 'dropped',
      },
      'AI 操作被拒，兜底推进阶段',
    );
    result = fire(core.INTENTS.phaseAdvance);
  }
  rt.state = result.state;

  if (gameOver(rt.state)) {
    finishGame(roomId);
    return;
  }
  // 与玩家 Intent 同一口径：只有被接受才重新计时（否则非法操作能无限续命）。
  // D-259：AI 在换牌阶段提交「跳过」后阶段会关闭，这里要顺势切到回合计时。
  syncTimers(roomId, rt);
  broadcastRoom(roomId);
  // 可能仍是 AI 的回合（出牌 / 攻击可以连着做），继续排下一拍。
  scheduleAi(roomId);
}

/** 一小局是否已结束（血空 / 认输 / 40 轮血量裁定 / 即死模式掉血）。 */
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
  clearMulliganTimer(rt);
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

  // 指挥官（D-184）：与卡组成对提交，开局时装配「30 张主卡组 + 这 1 位指挥官」。
  // 没有阵营之分 —— 卡池可以混选（ADR-0042）。
  const commanders: Record<string, string> = {};
  for (const s of room.seats) if (s) commanders[s.playerId] = s.commander;

  // 自建卡组（D-141）：入站时已用 `validateDeckList` 校验过，这里只做搬运。
  const customDecks: Record<string, readonly string[]> = {};
  for (const s of room.seats) if (s?.deck?.length) customDecks[s.playerId] = s.deck;

  // ① 先用真实座位 / 卡组建立「尚未开局」的初始状态，并作为快照下发给客户端。
  //
  //    ⚠️ 顺序不能反：`reduce` 是**增量**的，客户端必须先有起点状态，
  //    才能消化随后到来的开局事件。若先广播事件后发快照，开局那一批
  //    事件会被客户端丢弃（无从 reduce），表现为「开局日志凭空消失」。
  const prev = rt.state;
  const seedOpts = { seats, seed: nextSeed(), commanders, decks: customDecks };
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
  // D-259：此时停在换牌阶段，`syncTimers` 会改成 30s 换牌倒计时，而不是回合时限。
  syncTimers(roomId, rt);
  // 再发一次快照：这次才带上计时截止时刻（首次快照在 arm 之前，只能给 deadline = 0）。
  broadcastSnapshot(roomId);
  broadcastRoom(roomId);
  // 人机房（D-242）：先手可能是 AI，开局即排第一拍。
  scheduleAi(roomId);
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
    /*
     * 换牌阶段没有回合，`rt.timer` 是 `clear` 状态（`deadlineAt` 为 0），
     * 拿它下发会让顶栏显示「计时 —」（Era issue #99 看到的正是这个）。
     * 换牌自己的截止时刻存在 `rt.mulliganDeadline`（D-267）。
     */
    turnDeadline: rt.state.phase === 'mulligan' ? rt.mulliganDeadline : rt.timer.deadlineAt,
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

/**
 * 按连接限流（ADR-0039）。
 *
 * **不按 IP**：走 frpc TCP 隧道时所有公网客户端在服务端眼里都是 `127.0.0.1`，
 * 按 IP 罚会连坐所有朋友（`docs/20` §8.2 有完整推演）。
 * key 用 `socket.id`；断开时必须 `forget`，否则限流表自己就成了内存泄漏。
 */
const rlCreate = new WindowRateLimit({ limit: RL_CREATE_PER_MIN, windowMs: 60_000, now: () => Date.now() });
const rlJoin = new WindowRateLimit({ limit: RL_JOIN_PER_MIN, windowMs: 60_000, now: () => Date.now() });
const rlIntent = new WindowRateLimit({ limit: RL_INTENT_PER_SEC, windowMs: 1_000, now: () => Date.now() });

/** 限流被拒时的统一回包 —— 必须是人话，并给出还要等多久。 */
function rateLimited(retryAfterMs: number, ack?: (res: unknown) => void): void {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  ack?.({
    ok: false,
    error: ROOM_ERRORS.RATE_LIMITED,
    message: `操作太频繁，请等 ${seconds} 秒再试`,
  });
}

/**
 * 回放目录清理（X-20 / ADR-0040）。
 *
 * 失败只记日志 —— 清理是后台维护，不能因为它挂掉服务（与 D-176 同一个取舍）。
 */
async function sweepReplays(label: 'startup' | 'daily'): Promise<void> {
  try {
    const plan = await sweepReplayDir({
      dir: REPLAY_DIR,
      keepDays: REPLAY_KEEP_DAYS,
      maxBytes: REPLAY_MAX_MB * 1024 * 1024,
      dryRun: REPLAY_SWEEP_DRY_RUN,
    });
    fastify.log.info(
      {
        label,
        scanned: plan.scanned,
        removed: plan.remove.length,
        removedMb: Number((plan.removeBytes / 1024 / 1024).toFixed(2)),
        kept: plan.kept,
        keptMb: Number((plan.keptBytes / 1024 / 1024).toFixed(2)),
        failed: plan.failed,
        dryRun: REPLAY_SWEEP_DRY_RUN,
      },
      REPLAY_SWEEP_DRY_RUN ? '回放清理（dry-run：只算不删）' : '回放清理完成',
    );
  } catch (err) {
    fastify.log.error({ err, label }, '回放清理失败（不影响对局）');
  }
}

/** 房间已销毁的运行时：落盘回放后回收（同时清掉去重表与回合计时器）。 */
function sweepRuntimes(): void {
  for (const [roomId, rt] of runtimes) {
    if (roomManager.getRoom(roomId)) continue;
    runtimes.delete(roomId);
    // 房间没了，还挂着的 AI 定时器也要拔掉（D-242）—— 否则它会对着已销毁的房间空跑一次。
    const pending = aiTimers.get(roomId);
    if (pending) {
      clearTimeout(pending);
      aiTimers.delete(roomId);
    }
    // 不 clear 的话，定时器句柄会把已销毁房间的运行时吊住不释放。
    rt.timer.clear();
    clearMulliganTimer(rt);
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

/**
 * 重开前清掉旧对局的运行时（D-309 / #125）。
 *
 * 为什么是「销毁 + 重建」而不是「就地重置」：
 * ① **回放必须分成两份独立文件**（#125 验收 6）。回放只在房间销毁时落盘
 *    （`sweepRuntimes`），就地重置会让上一局的记录凭空消失；
 * ② `SeqGuard` / `serverSeq` / 计时器都描述「这一局进行到第几步」，跨局复用会让
 *    「第几步」失去意义，也让回放里的序号对不上。
 *
 * 与 `sweepRuntimes` 的区别只有一条：**房间不删**（席位、卡组、房间码都留着）。
 */
function resetRuntimeForRematch(roomId: string): RoomRuntime {
  const rt = runtimes.get(roomId);
  if (rt) {
    // 先拔定时器：AI 那一拍和回合超时都会对着「已经不存在的这一局」继续动作。
    const pending = aiTimers.get(roomId);
    if (pending) {
      clearTimeout(pending);
      aiTimers.delete(roomId);
    }
    rt.timer.clear();
    clearMulliganTimer(rt);
    runtimes.delete(roomId);
    // 与 `sweepRuntimes` 同一条取舍（D-176）：`void` 一个会 reject 的 Promise
    // 在 Node 22 上等于 unhandled rejection → 终止进程。回放丢了可以重打，服务不能挂。
    if (rt.replay.hasContent()) {
      void flushReplay(roomId, rt.replay.finish()).catch((err: unknown) => {
        fastify.log.error({ err, roomId }, '回放落盘失败（不影响重开）');
      });
    }
  }
  /*
   * 惰性建一份全新的：`startGame` 取的是 `runtimes.get`，这里必须先把它放回去，
   * 否则它会以「运行时不存在」直接返回 —— 表现为点了「再来一局」毫无反应。
   */
  return runtimeOf(roomId);
}

/**
 * 定期回收超出保留窗口的断线席位；频率取窗口的一半，够用且开销可忽略。
 *
 * D-233（Era 2026-10-21「掉线等 60s」）：宽限到期 = 该玩家已离开 ——
 * ① 按离开收尾对局（`abandonSeat`，与主动离开同一路径）；
 * ② 广播房间状态，让留下的一方立刻看到席位变化（此前只写日志，界面毫无变化）。
 */
const pruneTimer = setInterval(() => {
  const freed = roomManager.prune();
  for (const { playerId, roomId } of freed) {
    for (const rt of runtimes.values()) rt.guard.reset(playerId);
    fastify.log.info({ playerId, roomId }, '席位因超出保留窗口已释放');
    abandonSeat(roomId, playerId);
    broadcastRoom(roomId);
  }
  sweepRuntimes();
}, RECONNECT_GRACE_MS / 2);

/**
 * 回放清理定时器（X-20 / ADR-0040）：启动扫一次，之后每 24 小时一次。
 *
 * `unref()` 让这个定时器**不阻止进程退出** —— 否则优雅退出会被它吊住，
 * 与 `pruneTimer` 不同（那个在退出时显式 clear）。
 */
const REPLAY_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const replaySweepTimer = setInterval(() => void sweepReplays('daily'), REPLAY_SWEEP_INTERVAL_MS);
replaySweepTimer.unref();
void sweepReplays('startup');

/** 优雅退出：停掉巡检定时器再关服务，避免进程被定时器吊住。 */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(pruneTimer);
    clearInterval(replaySweepTimer);
    void fastify.close().then(() => process.exit(0));
  });
}

io.on('connection', (socket) => {
  // 全局连接上限（ADR-0039）：挡「开几万条连接、每条各占一间房」这种最粗糙的刷法。
  // 放在最前面 —— 连坐下文任何逻辑都不该为超限连接执行。
  if (io.engine.clientsCount > RL_MAX_CONNECTIONS) {
    fastify.log.warn(
      { socketId: socket.id, count: io.engine.clientsCount, limit: RL_MAX_CONNECTIONS },
      '连接数超过上限，拒绝新连接',
    );
    socket.disconnect(true);
    return;
  }
  fastify.log.info({ socketId: socket.id }, 'client connected');

  /** 建房：返回 playerId 与 token（客户端须自行保存，用于重连）。 */
  socket.on(SOCKET_EVENTS.roomCreate, (raw: unknown, ack?: (res: unknown) => void) => {
    const parsed = RoomCreateSchema.safeParse(raw);
    // ⚠️ 校验失败必须给玩家能看懂的话 —— 只回 INVALID_PAYLOAD 错误码，
    // 界面上就是一句天书（Era 2026-10-13 实测：人数填 22 超上限 8，
    // 只看到「操作失败：INVALID_PAYLOAD」，不知道哪里错了）。
    if (!parsed.success) {
      /*
       * 打日志（D-256）：校验失败原本是**静默**的 —— 服务端不留痕，客户端若把提示
       * 渲染在屏幕外，就成了「玩家说点了没反应、服务端查不到任何记录」。
       */
      fastify.log.warn(
        { socketId: socket.id, issues: parsed.error.issues.slice(0, 3) },
        '建房参数不合法',
      );
      return ack?.({
        ok: false,
        error: 'INVALID_PAYLOAD',
        message: '参数不合法：昵称需 1–24 个字；卡组需正好 30 张、指挥官需有效',
      });
    }
    // 限流（ADR-0039）：按连接计数，穿透部署下按 IP 会连坐所有玩家。
    const gate = rlCreate.take(socket.id);
    if (!gate.ok) return rateLimited(gate.retryAfterMs, ack);
    // 全局房间上限：防止被刷到内存耗尽。
    if (roomManager.count() >= RL_MAX_ROOMS) {
      fastify.log.warn({ rooms: roomManager.count(), limit: RL_MAX_ROOMS }, '房间数达到上限，拒绝建房');
      return ack?.({
        ok: false,
        error: ROOM_ERRORS.RATE_LIMITED,
        message: '服务器房间数已达上限，请稍后再试',
      });
    }
    const r = roomManager.create(parsed.data);
    if (!r.ok) {
      fastify.log.warn(
        { socketId: socket.id, error: r.error, message: r.message },
        '建房被房间层拒绝',
      );
      return ack?.({ ok: false, error: r.error, message: r.message });
    }
    fastify.log.info(
      {
        socketId: socket.id,
        code: r.value.room.code,
        solo: parsed.data.solo === true,
        deckCards: parsed.data.deck?.length ?? 0,
        turnTimeoutMs: r.value.room.turnTimeoutMs,
      },
      '建房成功',
    );
    // 先放掉旧席位再挂新的（D-181）：否则旧房间永不释放。
    releaseSeatOf(socket);
    socket.data.playerId = r.value.seat.playerId;
    void socket.join(r.value.room.id);
    // H18：新建的 runtime 按房间档位定时限（建房时一定未开始计时）。
    runtimeOf(r.value.room.id).timer.setTimeoutMs(resolveTurnTimeout(r.value.room.id));
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
    if (!parsed.success) {
      fastify.log.warn(
        { socketId: socket.id, issues: parsed.error.issues.slice(0, 3) },
        '加入房间参数不合法',
      );
      return ack?.({
        ok: false,
        error: 'INVALID_PAYLOAD',
        message: '参数不合法：房间码不能为空，昵称需 1–24 个字',
      });
    }
    // 阈值比建房宽松：输错房码重试是正常行为（ADR-0039）。
    const gate = rlJoin.take(socket.id);
    if (!gate.ok) return rateLimited(gate.retryAfterMs, ack);
    const r = roomManager.join(parsed.data);
    if (!r.ok) {
      fastify.log.warn(
        { socketId: socket.id, code: parsed.data.code, error: r.error },
        '加入房间被拒绝',
      );
      return ack?.({ ok: false, error: r.error, message: r.message });
    }
    // 先加入成功再放旧席位（D-181）：反过来一旦加入失败，玩家会连原来那间也没了。
    releaseSeatOf(socket);
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
    // 同一条连接换了席位才需要放旧的；重连同一席位时释放会把刚恢复的席位删掉。
    if (socket.data.playerId && socket.data.playerId !== parsed.data.playerId) releaseSeatOf(socket);
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
   * 空数组 = 回到服务端默认卡组。
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

    // D-184：卡组与指挥官一起换（`RoomDeckSchema` 已显式声明 commander，否则会被 strip）。
    const r = roomManager.setDeck(
      located.room.id,
      playerId,
      parsed.data.deck,
      parsed.data.commander,
    );
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

  /**
   * 再来一局（D-309 / #125）—— 系列赛打完原地重开。
   *
   * 与 `room:next-game` 分开：那个是 BO3 局间（房主独裁、比分累计、先手轮换），
   * 这个是整场打完之后的重开（**双方都同意**、比分归零、重新掷骰定先后手）。
   * 人机房 AI 不会点按钮，`voteRematch` 对 solo 房间单票即开。
   */
  socket.on(SOCKET_EVENTS.roomRematch, (_raw: unknown, ack?: (res: unknown) => void) => {
    const playerId = socket.data.playerId as string | undefined;
    if (!playerId) return ack?.({ ok: false, error: ROOM_ERRORS.NOT_IN_ROOM, message: '不在房间内' });

    const vote = roomManager.voteRematch(playerId);
    if (!vote.ok) return ack?.({ ok: false, error: vote.error, message: vote.message });
    const room = vote.value.room;

    if (!vote.value.shouldStart) {
      /*
       * 只差对手那一票：把他的票数广播出去，对手的结算卡片上会出现「对手想再来一局」——
       * 否则点过的人只能干等，看不出「是我在等」还是「对面根本没看见」。
       */
      broadcastRoom(room.id);
      return ack?.({ ok: true, room: roomManager.publicView(room), waiting: true });
    }

    // 双方都同意 → 旧对局收尾（回放落盘）→ 用**首次开局**的同一条路径重建。
    resetRuntimeForRematch(room.id);
    roomManager.resetForRematch(room.id);
    startGame(room.id);
    broadcastRoom(room.id);
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
    // D-132：同时判负整个系列赛；与「断线宽限到期」共用 `abandonSeat`（D-233）。
    if (before) abandonSeat(before.room.id, playerId);

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

    /*
     * 入站 Intent 一律按**玩家**发起处理（D-239 / T-09，安全边界）。
     * 见 `room/inbound.ts` 的说明：`actor` 决定 baseGuard 的回合检查与
     * pendingChoice 全局守卫是否生效，客户端无权自称 `system`。
     */
    const intent: Intent = normalizePlayerIntent(parsed.data as Intent);

    const located = roomManager.locate(intent.playerId);
    if (!located) return ack?.({ ok: false, error: 'NOT_IN_ROOM' });

    const rt = runtimeOf(located.room.id);

    /*
     * Intent 限流（ADR-0039）。
     *
     * ⚠️ 客户端的 `socket.emit(gameIntent, intent)` **没有带 ack 回调**（useRoom.ts:492），
     * 所以只回 ack 玩家看不到任何提示。必须走 `game:events` 的 rejected 分支 ——
     * 那是客户端唯一会渲染「操作被拒绝」原因的通道。
     *
     * 不写进回放：被限流的请求没有产生任何状态变化，记进回放会让记录与实际不符。
     */
    const gate = rlIntent.take(socket.id);
    if (!gate.ok) {
      rt.serverSeq += 1;
      const message = '操作太频繁，请稍等一下';
      socket.emit(SOCKET_EVENTS.gameEvents, {
        kind: 'rejected',
        playerId: intent.playerId,
        seq: intent.seq,
        error: { code: ROOM_ERRORS.RATE_LIMITED, message },
        serverSeq: rt.serverSeq,
      });
      return ack?.({ ok: false, error: ROOM_ERRORS.RATE_LIMITED, message });
    }

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
        // D-259：换牌阶段与回合用两套计时，统一交给 `syncTimers` 按阶段选。
        syncTimers(located.room.id, rt);
        // 人机房（D-242）：玩家这一手做完可能就轮到 AI 了。
        scheduleAi(located.room.id);
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
    // 限流表按 socket.id 记，必须跟着连接一起清 —— 否则「限流」本身会变成内存泄漏。
    rlCreate.forget(socket.id);
    rlJoin.forget(socket.id);
    rlIntent.forget(socket.id);
    if (!playerId) return;
    // 断线保留席位（不立即释放）；到点由 prune 回收。
    roomManager.markDisconnected(playerId);
    const located = roomManager.locate(playerId);
    if (located) broadcastRoom(located.room.id);
  });
});

fastify.log.info({ port: PORT, host: HOST }, 'server ready');
