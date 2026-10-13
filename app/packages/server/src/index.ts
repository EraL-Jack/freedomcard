import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { Server as IOServer } from 'socket.io';

import * as core from '@app/core';
import {
  EchoSchema,
  IntentSchema,
  RoomCreateSchema,
  RoomJoinSchema,
  RoomReconnectSchema,
  SOCKET_EVENTS,
  RECONNECT_GRACE_MS,
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
  type ReplayRecord,
} from './room/index.js';

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

/** 每间房一份对局运行时：状态、去重表、回放记录、广播序号。 */
interface RoomRuntime {
  state: GameState;
  guard: SeqGuard;
  replay: ReplayRecorder;
  serverSeq: number;
}
const runtimes = new Map<string, RoomRuntime>();

function runtimeOf(roomId: string): RoomRuntime {
  let rt = runtimes.get(roomId);
  if (!rt) {
    // 空座位的初始状态：真正开局（洗牌 / 发牌 / 掷骰）由 `start_game` Intent 建立。
    // 卡组此刻尚未提交，故 `decks` 为空 —— 这不是占位偷懒，而是「卡组在开局时才进入状态」。
    const state = core.createInitialState({ seed: Date.now() >>> 0, seats: [], decks: {} });
    rt = { state, guard: new SeqGuard(), replay: new ReplayRecorder(Date.now()), serverSeq: 0 };
    runtimes.set(roomId, rt);
  }
  return rt;
}

function broadcastRoom(roomId: string): void {
  const room = roomManager.getRoom(roomId);
  if (room) io.to(roomId).emit(SOCKET_EVENTS.roomState, roomManager.publicView(room));
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

/** 房间已销毁的运行时：落盘回放后回收（同时清掉去重表）。 */
function sweepRuntimes(): void {
  for (const [roomId, rt] of runtimes) {
    if (roomManager.getRoom(roomId)) continue;
    runtimes.delete(roomId);
    void flushReplay(roomId, rt.replay.finish());
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
    if (!parsed.success) return ack?.({ ok: false, error: 'INVALID_PAYLOAD' });
    const r = roomManager.create(parsed.data);
    if (!r.ok) return ack?.({ ok: false, error: r.error, message: r.message });
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
    if (!parsed.success) return ack?.({ ok: false, error: 'INVALID_PAYLOAD' });
    const r = roomManager.join(parsed.data);
    if (!r.ok) return ack?.({ ok: false, error: r.error, message: r.message });
    socket.data.playerId = r.value.seat.playerId;
    void socket.join(r.value.room.id);
    broadcastRoom(r.value.room.id);
    ack?.({
      ok: true,
      room: roomManager.publicView(r.value.room),
      playerId: r.value.seat.playerId,
      token: r.value.seat.token,
      seat: r.value.seat.seat,
    });
  });

  /** 重连：校验凭据与保留窗口，返回 lastSeq 与完整快照。 */
  socket.on(SOCKET_EVENTS.roomReconnect, (raw: unknown, ack?: (res: unknown) => void) => {
    const parsed = RoomReconnectSchema.safeParse(raw);
    if (!parsed.success) return ack?.({ ok: false, error: 'INVALID_PAYLOAD' });
    const r = roomManager.reconnect(parsed.data);
    if (!r.ok) return ack?.({ ok: false, error: r.error, message: r.message });
    socket.data.playerId = r.value.seat.playerId;
    void socket.join(r.value.room.id);
    const rt = runtimeOf(r.value.room.id);
    const playerIds = r.value.room.seats.flatMap((s) => (s ? [s.playerId] : []));
    const snapshot = buildSnapshot(rt.state, rt.serverSeq, rt.guard, playerIds, core);
    broadcastRoom(r.value.room.id);
    ack?.({ ok: true, room: roomManager.publicView(r.value.room), snapshot });
  });

  socket.on(SOCKET_EVENTS.roomLeave, (_raw: unknown, ack?: (res: unknown) => void) => {
    const playerId = socket.data.playerId as string | undefined;
    if (!playerId) return ack?.({ ok: false, error: 'NOT_IN_ROOM' });
    const before = roomManager.locate(playerId);
    const r = roomManager.leave(playerId);
    if (!r.ok) return ack?.({ ok: false, error: r.error, message: r.message });
    if (before) void socket.leave(before.room.id);
    if (r.value.room) broadcastRoom(r.value.room.id);
    else sweepRuntimes();
    ack?.({ ok: true });
  });

  /**
   * Intent 入站：走完整处理链（去重 → 引擎 → reduce → 哈希 → 回放 → 广播），全程同步。
   * 当前 `core.applyIntent` 仍是 `TODO(slot)`，会返回 `NOT_IMPLEMENTED` —— 这是预期状态，
   * 等 `docs/06` A 组输入后由注册表接管。
   */
  socket.on(SOCKET_EVENTS.gameIntent, (raw: unknown, ack?: (res: unknown) => void) => {
    const parsed = IntentSchema.safeParse(raw);
    if (!parsed.success) return ack?.({ ok: false, error: 'INVALID_PAYLOAD' });
    const intent = parsed.data as Intent;

    const located = roomManager.locate(intent.playerId);
    if (!located) return ack?.({ ok: false, error: 'NOT_IN_ROOM' });

    const rt = runtimeOf(located.room.id);
    const result = submitIntent(rt.state, intent, {
      engine: core,
      guard: rt.guard,
      replay: rt.replay,
      now: () => Date.now(),
      cards: CARD_POOL,
      emit: (out) => {
        rt.serverSeq += 1;
        if (out.kind === 'accepted') {
          io.to(located.room.id).emit(SOCKET_EVENTS.gameEvents, { ...out, serverSeq: rt.serverSeq });
        } else {
          socket.emit(SOCKET_EVENTS.gameEvents, { ...out, serverSeq: rt.serverSeq });
        }
      },
    });
    rt.state = result.state;
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
