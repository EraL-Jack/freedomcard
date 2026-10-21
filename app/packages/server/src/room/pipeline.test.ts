import { describe, expect, it } from 'vitest';

import { createInitialState } from '@app/core';

import type { GameEvent, GameState, Intent, Rejection, Result, RuleContext } from '@app/shared';

import {
  buildSnapshot,
  submitIntent,
  submitSystemIntent,
  type EnginePort,
  type PipelineDeps,
  type PipelineOut,
} from './pipeline.js';
import { ReplayRecorder } from './replay.js';
import { SeqGuard } from './seq-guard.js';

/**
 * 假引擎：不实现任何玩法，只做「记录 + 推进 rngCursor」的可观测替身。
 * 会话层的正确性不依赖具体规则，因此用替身验证是充分的。
 */
function fakeEngine(): EnginePort & { calls: Intent[] } {
  const calls: Intent[] = [];
  return {
    calls,
    applyIntent(state: GameState, intent: Intent, ctx: RuleContext): Result<GameEvent[], Rejection> {
      calls.push(intent);
      if (intent.type === 'illegal') {
        return { ok: false, error: { code: 'ILLEGAL', message: '非法操作（替身）' } };
      }
      return {
        ok: true,
        value: [{ type: `did:${intent.type}`, at: ctx.now }],
      };
    },
    reduce(state: GameState, event: GameEvent): GameState {
      return { rngCursor: state.rngCursor + 1, lastEvent: event.type } as GameState & { lastEvent: string };
    },
    stateHash(state: GameState): string {
      return `h${Math.abs(state.rngCursor)}`;
    },
  };
}

function harness() {
  const engine = fakeEngine();
  const guard = new SeqGuard();
  const replay = new ReplayRecorder(0);
  const emitted: PipelineOut[] = [];
  let t = 1000;
  const deps: PipelineDeps = {
    engine,
    guard,
    replay,
    now: () => t,
    emit: (out) => emitted.push(out),
    cards: {},
  };
  const state0: GameState = createInitialState({
    seed: 0,
    seats: ['p1', 'p2'],
    decks: {},
    commanders: {},
  });
  return { engine, guard, replay, emitted, deps, state0, tick: (ms: number) => (t += ms) };
}

const intent = (seq: number, type = 'act', playerId = 'p1'): Intent => ({
  type,
  actor: 'player',
  playerId,
  seq,
});

/*
 * ⚠️ 下面几条断言写的是「相对初值」（`h.state0.rngCursor + n`），不是写死的 1 / 2。
 *
 * 原先它们写死 `1`，隐含假设「初始游标恒为 0」—— 那恰恰是 D-269 的缺陷
 * （`createInitialState` 把 seed 丢了、游标写死 0）。夹具跟着缺陷一起写死，
 * 修好之后反而「测试红了、产品对了」，属于把实现细节钉进了断言。
 * 会话层关心的是「一次接受的 Intent 恰好把游标推进 1 步」，与初值无关。
 */
describe('Intent 处理链 · 去重', () => {
  it('首次提交被接受并推进状态', () => {
    const h = harness();
    const r = submitIntent(h.state0, intent(1), h.deps);
    expect(r.out.kind).toBe('accepted');
    expect(r.state.rngCursor).toBe(h.state0.rngCursor + 1);
    expect(h.replay.current().intents).toHaveLength(1);
  });

  it('同一 seq 重复提交被丢弃，状态不变（幂等）', () => {
    const h = harness();
    const first = submitIntent(h.state0, intent(1), h.deps);
    const second = submitIntent(first.state, intent(1), h.deps);
    expect(second.out.kind).toBe('dropped');
    if (second.out.kind === 'dropped') expect(second.out.reason).toBe('DUPLICATE');
    expect(second.state).toEqual(first.state);
    expect(h.engine.calls).toHaveLength(1); // 引擎只被调用一次
    expect(h.replay.current().intents).toHaveLength(1);
  });

  it('乱序（seq 回退）被丢弃为 STALE', () => {
    const h = harness();
    const first = submitIntent(h.state0, intent(5), h.deps);
    const stale = submitIntent(first.state, intent(3), h.deps);
    expect(stale.out.kind).toBe('dropped');
    if (stale.out.kind === 'dropped') expect(stale.out.reason).toBe('STALE');
  });

  it('不同玩家各自独立计数，互不干扰', () => {
    const h = harness();
    const a = submitIntent(h.state0, intent(1, 'act', 'p1'), h.deps);
    const b = submitIntent(a.state, intent(1, 'act', 'p2'), h.deps);
    expect(a.out.kind).toBe('accepted');
    expect(b.out.kind).toBe('accepted');
  });

  it('重连后按 lastSeq+1 续发不被误判重复', () => {
    const h = harness();
    const r1 = submitIntent(h.state0, intent(1), h.deps);
    const last = h.guard.lastSeqOf('p1');
    expect(last).toBe(1);
    // 客户端重连后从 lastSeq+1 续发
    const r2 = submitIntent(r1.state, intent(last + 1), h.deps);
    expect(r2.out.kind).toBe('accepted');
    // 若误用本地计数归零重来，则会被判 STALE
    const bad = submitIntent(r2.state, intent(1), h.deps);
    expect(bad.out.kind).toBe('dropped');
  });
});

describe('Intent 处理链 · 拒绝与哈希', () => {
  it('引擎拒绝时零副作用：状态不变、不记回放', () => {
    const h = harness();
    const r = submitIntent(h.state0, intent(1, 'illegal'), h.deps);
    expect(r.out.kind).toBe('rejected');
    expect(r.state).toEqual(h.state0);
    expect(h.replay.current().intents).toHaveLength(0);
  });

  it('事件时间戳取自注入时钟，不来自引擎内部', () => {
    const h = harness();
    h.tick(5000);
    const r = submitIntent(h.state0, intent(1), h.deps);
    if (r.out.kind !== 'accepted') throw new Error('expected accepted');
    expect(r.out.events[0]?.at).toBe(6000);
  });

  it('广播回调同步执行（无 await 让出）', () => {
    const h = harness();
    let syncSeen = false;
    const deps: PipelineDeps = { ...h.deps, emit: () => (syncSeen = true) };
    submitIntent(h.state0, intent(1), deps);
    expect(syncSeen).toBe(true);
  });
});

describe('系统 Intent · 与玩家同链路', () => {
  it('超时构造的系统 Intent 走同一链路并进入回放', () => {
    const h = harness();
    const r1 = submitIntent(h.state0, intent(1), h.deps);
    const systemIntent: Intent = {
      type: 'end_turn',
      actor: 'system',
      playerId: 'p1',
      seq: 0,
      reason: 'timeout',
    };
    const r2 = submitSystemIntent(r1.state, systemIntent, h.deps);
    expect(r2.out.kind).toBe('accepted');
    expect(r2.state.rngCursor).toBe(h.state0.rngCursor + 2);

    const rec = h.replay.current();
    expect(rec.intents).toHaveLength(2);
    expect(rec.intents[1]?.actor).toBe('system');
    expect(rec.intents[1]?.reason).toBe('timeout');
    expect(rec.hashChain).toEqual([`h${h.state0.rngCursor + 1}`, `h${h.state0.rngCursor + 2}`]);
  });

  it('系统 Intent 不参与玩家 seq 去重', () => {
    const h = harness();
    const r1 = submitIntent(h.state0, intent(1), h.deps);
    const sys: Intent = { type: 'end_turn', actor: 'system', playerId: 'p1', seq: 0, reason: 'timeout' };
    const a = submitSystemIntent(r1.state, sys, h.deps);
    const b = submitSystemIntent(a.state, sys, h.deps);
    expect(a.out.kind).toBe('accepted');
    expect(b.out.kind).toBe('accepted');
    expect(h.guard.lastSeqOf('p1')).toBe(1); // 未被系统 Intent 污染
  });
});

describe('快照', () => {
  it('快照带每玩家 lastSeq，供重连续发', () => {
    const h = harness();
    const r = submitIntent(h.state0, intent(1, 'act', 'p1'), h.deps);
    const snap = buildSnapshot(r.state, 7, h.guard, ['p1', 'p2'], h.engine);
    expect(snap.serverSeq).toBe(7);
    expect(snap.lastSeqByPlayer).toEqual({ p1: 1, p2: 0 });
    expect(snap.hash).toBe(`h${h.state0.rngCursor + 1}`);
  });
});
