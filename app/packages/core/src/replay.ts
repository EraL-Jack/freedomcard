import type { CardDef, GameEvent, GameState, Intent, Rejection, Result, RuleContext } from '@app/shared/types';

/**
 * 回放与确定性校验。
 *
 * 粒度：**种子 + Intent 序列** —— 比只记 Event 序列更严格，重跑时能同时验证 handler 与 reduce。
 *
 * ⚠️ 时间源必须**注入**：`now(step)` 按步给出时间戳，不得读真时钟。
 * 否则同一个 Intent 序列两次回放会产出不同事件，M8（回放一致性）必然失败且极难定位。
 */
export interface ReplayDeps {
  applyIntent(state: GameState, intent: Intent, ctx: RuleContext): Result<GameEvent[], Rejection>;
  reduce(state: GameState, event: GameEvent): GameState;
  stateHash(state: GameState): string;
  /** 第 `step` 步的时间戳（从 0 开始）。回放时按步复现，保证两次运行完全一致。 */
  now(step: number): number;
  /** 卡池定义 —— 规则处理器据以查 `cost` / `power` / 关键词，随 `ctx` 一起注入。 */
  cards: Record<string, CardDef>;
}

export interface ReplayOutcome {
  state: GameState;
  events: GameEvent[][];
  hashChain: string[];
  /** 首个失败步骤的索引；`null` 表示全程通过。 */
  failedAt: number | null;
  failure: Rejection | null;
}

/** 按顺序重跑一遍 Intent 序列，产出事件与哈希链。 */
export function replay(initial: GameState, intents: readonly Intent[], deps: ReplayDeps): ReplayOutcome {
  let state = initial;
  const events: GameEvent[][] = [];
  const hashChain: string[] = [];

  for (let i = 0; i < intents.length; i++) {
    const res = deps.applyIntent(state, intents[i]!, { now: deps.now(i), cards: deps.cards });
    if (!res.ok) {
      return { state, events, hashChain, failedAt: i, failure: res.error };
    }
    for (const event of res.value) {
      state = deps.reduce(state, event);
    }
    events.push(res.value);
    hashChain.push(deps.stateHash(state));
  }
  return { state, events, hashChain, failedAt: null, failure: null };
}

/**
 * 确定性校验：同一初始状态 + 同一 Intent 序列跑两次，哈希链必须完全一致。
 *
 * 这条能抓出两类隐蔽缺陷：handler 内读了时钟 / 用了 `Math.random()`，
 * 或在 handler 外持有了影响结果的隐藏状态。
 */
export function isDeterministic(initial: GameState, intents: readonly Intent[], deps: ReplayDeps): boolean {
  const a = replay(initial, intents, deps);
  const b = replay(initial, intents, deps);
  if (a.hashChain.length !== b.hashChain.length) return false;
  return a.hashChain.every((h, i) => h === b.hashChain[i]);
}
