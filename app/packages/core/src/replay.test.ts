import { describe, expect, it, vi } from 'vitest';

import type { GameEvent, GameState, Intent, Result, Rejection } from '@app/shared';

import { isDeterministic, replay, type ReplayDeps } from './replay.js';

/**
 * 用纯函数替身验证「回放与确定性」本身 —— 不涉及任何玩法。
 *
 * 两条反向用例（外部可变状态 / 读时钟）是**故意设计成会失败**的：
 * 它们证明 `isDeterministic` 真的能抓到问题，而不是一个永远返回 true 的空测试。
 */

type Mutable = GameState & { n: number };

const state0: Mutable = { rngCursor: 0, n: 0 };

function seq(...types: string[]): Intent[] {
  return types.map((type, i) => ({ type, actor: 'player' as const, playerId: 'p1', seq: i + 1 }));
}

/** 确定性替身：结果只由 state 与 intent 决定；`n` 累加事件名长度。 */
function deterministicDeps(): ReplayDeps {
  return {
    applyIntent: (_state, intent, ctx): Result<GameEvent[], Rejection> => ({
      ok: true,
      value: [{ type: `did:${intent.type}`, at: ctx.now }],
    }),
    reduce: (state, event): GameState => {
      const s = state as Mutable;
      return { rngCursor: s.rngCursor + 1, n: s.n + event.type.length };
    },
    stateHash: (state) => `h${(state as Mutable).rngCursor}-${(state as Mutable).n}`,
    now: (step) => 1000 + step * 10,
  };
}

describe('回放 · 序列重跑', () => {
  it('逐步产出事件与哈希链', () => {
    // 每步 1 个事件，事件名 `did:a` 长度 5 —— n 依次 5 / 10 / 15。
    const out = replay(state0, seq('a', 'b', 'c'), deterministicDeps());
    expect(out.failedAt).toBeNull();
    expect(out.events).toHaveLength(3);
    expect(out.hashChain).toEqual(['h1-5', 'h2-10', 'h3-15']);
  });

  it('时间戳按步注入，不读真时钟', () => {
    const out = replay(state0, seq('a', 'b'), deterministicDeps());
    expect(out.events[0]?.[0]?.at).toBe(1000);
    expect(out.events[1]?.[0]?.at).toBe(1010);
  });

  it('遇到拒绝时停下并带回失败位置', () => {
    const deps: ReplayDeps = {
      ...deterministicDeps(),
      applyIntent: (_state, intent, ctx): Result<GameEvent[], Rejection> =>
        intent.type === 'bad'
          ? { ok: false, error: { code: 'ILLEGAL', message: '非法' } }
          : { ok: true, value: [{ type: `did:${intent.type}`, at: ctx.now }] },
    };
    const out = replay(state0, seq('a', 'bad', 'c'), deps);
    expect(out.failedAt).toBe(1);
    expect(out.failure?.code).toBe('ILLEGAL');
    expect(out.hashChain).toHaveLength(1); // 失败步骤不进哈希链
  });
});

describe('回放 · 确定性校验', () => {
  it('纯函数实现两次运行哈希链一致', () => {
    expect(isDeterministic(state0, seq('a', 'b', 'c'), deterministicDeps())).toBe(true);
  });

  it('handler 依赖外部可变状态时判定为不确定（反向用例：证明检查非空转）', () => {
    let hidden = 0;
    const deps: ReplayDeps = {
      ...deterministicDeps(),
      applyIntent: (_state, intent, ctx): Result<GameEvent[], Rejection> => {
        hidden += 1;
        // 事件名长度随外部计数器变化 → 两次运行的哈希链必然不同
        return { ok: true, value: [{ type: `did:${intent.type}${'x'.repeat(hidden)}`, at: ctx.now }] };
      },
    };
    expect(isDeterministic(state0, seq('a', 'b'), deps)).toBe(false);
  });

  it('handler 内读时钟时，两次运行哈希链不同（反向用例）', () => {
    // 让哈希依赖事件时间戳，再用假时钟拉开两次回放的系统时间。
    const clockDeps: ReplayDeps = {
      applyIntent: (_state, intent): Result<GameEvent[], Rejection> => ({
        ok: true,
        value: [{ type: `did:${intent.type}`, at: Date.now() }], // ← 违规：handler 内读时钟
      }),
      reduce: (state, event): GameState => {
        const s = state as Mutable;
        return { rngCursor: s.rngCursor + 1, n: s.n + event.at };
      },
      stateHash: (state) => `h${(state as Mutable).rngCursor}-${(state as Mutable).n}`,
      now: (step) => step,
    };

    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const first = replay(state0, seq('a'), clockDeps);
      vi.setSystemTime(9_999);
      const second = replay(state0, seq('a'), clockDeps);
      expect(first.hashChain).not.toEqual(second.hashChain);
    } finally {
      vi.useRealTimers();
    }
  });

  it('时间走注入源（不读时钟）时，即使哈希含时间戳也一致', () => {
    const okDeps: ReplayDeps = {
      applyIntent: (_state, intent, ctx): Result<GameEvent[], Rejection> => ({
        ok: true,
        value: [{ type: `did:${intent.type}`, at: ctx.now }], // ← 正确：用注入的 ctx.now
      }),
      reduce: (state, event): GameState => {
        const s = state as Mutable;
        return { rngCursor: s.rngCursor + 1, n: s.n + event.at };
      },
      stateHash: (state) => `h${(state as Mutable).rngCursor}-${(state as Mutable).n}`,
      now: (step) => 1000 + step,
    };
    expect(isDeterministic(state0, seq('a', 'b'), okDeps)).toBe(true);
  });
});
