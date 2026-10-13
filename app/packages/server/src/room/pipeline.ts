import type {
  CardDef,
  GameEvent,
  GameState,
  Intent,
  PlayerId,
  Rejection,
  Result,
  RuleContext,
} from '@app/shared';

import type { ReplayRecorder } from './replay.js';
import type { SeqGuard } from './seq-guard.js';

/**
 * 引擎端口 —— 会话层只依赖这三个纯函数，**不依赖任何具体玩法**。
 * 生产环境注入 `@app/core`，单测注入假实现。
 */
export interface EnginePort {
  applyIntent(state: GameState, intent: Intent, ctx: RuleContext): Result<GameEvent[], Rejection>;
  reduce(state: GameState, event: GameEvent): GameState;
  stateHash(state: GameState): string;
}

export type DropReason = 'DUPLICATE' | 'STALE';

export type PipelineOut =
  | { kind: 'accepted'; playerId: PlayerId; seq: number; events: GameEvent[]; hash: string }
  | { kind: 'rejected'; playerId: PlayerId; seq: number; error: Rejection }
  | { kind: 'dropped'; playerId: PlayerId; seq: number; reason: DropReason };

export interface PipelineDeps {
  engine: EnginePort;
  guard: SeqGuard;
  replay: ReplayRecorder;
  /** 注入时钟：事件时间戳的唯一来源（core 内禁止读时钟）。 */
  now(): number;
  /** 广播回调。必须**同步**执行，见下方「禁止 await」说明。 */
  emit(out: PipelineOut): void;
  /** 卡池定义 —— 透传给规则引擎的 `RuleContext`，引擎据此查 `cost` / `power` / 关键词。 */
  cards: Record<string, CardDef>;
}

export interface SubmitResult {
  state: GameState;
  out: PipelineOut;
}

/**
 * 一次 Intent 的完整处理链：去重 → 校验 → 产出事件 → reduce → 哈希 → 记录 → 广播。
 *
 * ⚠️ **本函数全程同步，禁止引入 `await`**（ADR-0011）。Node 单线程下无异步让出的同步链路
 * 天然原子，两名玩家同时出牌不会撞状态；一旦插入异步（哪怕只是一个 `await redis.get()`），
 * 就会引入「旧测试通过、高并发才偶发」的那一类最难查的竞态。持久化等异步操作一律放到本函数之后。
 */
export function submitIntent(state: GameState, intent: Intent, deps: PipelineDeps): SubmitResult {
  const verdict = deps.guard.check(intent.playerId, intent.seq);
  if (!verdict.ok) {
    const out: PipelineOut = { kind: 'dropped', playerId: intent.playerId, seq: intent.seq, reason: verdict.reason };
    deps.emit(out);
    return { state, out };
  }

  const res = deps.engine.applyIntent(state, intent, { now: deps.now(), cards: deps.cards });
  if (!res.ok) {
    const out: PipelineOut = { kind: 'rejected', playerId: intent.playerId, seq: intent.seq, error: res.error };
    deps.emit(out);
    return { state, out };
  }

  let next = state;
  for (const event of res.value) {
    next = deps.engine.reduce(next, event);
  }
  const hash = deps.engine.stateHash(next);
  deps.replay.recordStep(intent, res.value, hash);

  const out: PipelineOut = {
    kind: 'accepted',
    playerId: intent.playerId,
    seq: intent.seq,
    events: res.value,
    hash,
  };
  deps.emit(out);
  return { state: next, out };
}

/**
 * 系统 Intent 与玩家 Intent 走**同一条链路**（ADR-0011）。
 *
 * 例如回合超时：由会话层（唯一允许读时钟的地方）发现超时，构造
 * `{ actor: 'system', reason: 'timeout' }` 后调用本函数 —— 禁止在 core 内读时钟，
 * 也禁止会话层绕过引擎直接改 GameState（那会让 stateHash 断裂、客户端 reduce 不出同一结果）。
 *
 * 系统 Intent 不参与 seq 去重（它不是某个玩家发出的），因此直接跳过 guard。
 */
export function submitSystemIntent(
  state: GameState,
  intent: Intent,
  deps: Omit<PipelineDeps, 'guard'> & { guard?: SeqGuard },
): SubmitResult {
  const res = deps.engine.applyIntent(state, intent, { now: deps.now(), cards: deps.cards });
  if (!res.ok) {
    const out: PipelineOut = { kind: 'rejected', playerId: intent.playerId, seq: intent.seq, error: res.error };
    deps.emit(out);
    return { state, out };
  }
  let next = state;
  for (const event of res.value) {
    next = deps.engine.reduce(next, event);
  }
  const hash = deps.engine.stateHash(next);
  deps.replay.recordStep(intent, res.value, hash);
  const out: PipelineOut = {
    kind: 'accepted',
    playerId: intent.playerId,
    seq: intent.seq,
    events: res.value,
    hash,
  };
  deps.emit(out);
  return { state: next, out };
}

/** 重连快照：状态 + 哈希 + 每个玩家的 `lastSeq`（客户端据此续发）。 */
export interface Snapshot {
  state: GameState;
  hash: string;
  serverSeq: number;
  lastSeqByPlayer: Record<PlayerId, number>;
}

export function buildSnapshot(
  state: GameState,
  serverSeq: number,
  guard: SeqGuard,
  playerIds: readonly PlayerId[],
  engine: Pick<EnginePort, 'stateHash'>,
): Snapshot {
  const lastSeqByPlayer: Record<PlayerId, number> = {};
  for (const id of playerIds) lastSeqByPlayer[id] = guard.lastSeqOf(id);
  return { state, hash: engine.stateHash(state), serverSeq, lastSeqByPlayer };
}
