/**
 * 种子随机数发生器 —— 纯函数、无副作用、可复现。
 *
 * 设计要点（ADR-0010）：
 * - 随机游标 `rngCursor` 存在 `GameState` 里，由 reducer 推进；本模块不保存任何内部状态。
 * - 每次取值返回新游标，调用方负责把它写回 state（handler 取值写事件，reducer 推进）。
 * - 同游标 + 同调用序列 → 必得同结果，因此「种子 + Intent 序列」可完整重放一局。
 *
 * 算法：mulberry32（32 位状态，单次乘加推进，跨平台一致）。
 */

/** 单次推进的步长（mulberry32 的魔数常量）。 */
const STEP = 0x6d2b79f5;

export interface RngStep {
  /** [0, 1) 区间的浮点数。 */
  value: number;
  /** 推进后的游标，必须写回 `GameState.rngCursor`。 */
  nextCursor: number;
}

/** 从游标推进一步，返回随机值与新游标。 */
export function nextFloat(cursor: number): RngStep {
  const next = (cursor + STEP) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, nextCursor: next };
}

/** 取 `[0, maxExclusive)` 内的整数。 */
export function nextInt(cursor: number, maxExclusive: number): RngStep {
  if (maxExclusive <= 0) {
    return { value: 0, nextCursor: cursor };
  }
  const step = nextFloat(cursor);
  return { value: Math.floor(step.value * maxExclusive), nextCursor: step.nextCursor };
}

/**
 * Fisher-Yates 洗牌（不改变入参）。
 * @returns 洗好的新数组与推进后的游标。
 */
export function shuffle<T>(cursor: number, items: readonly T[]): { items: T[]; nextCursor: number } {
  const out = items.slice();
  let c = cursor;
  for (let i = out.length - 1; i > 0; i--) {
    const step = nextFloat(c);
    c = step.nextCursor;
    const j = Math.floor(step.value * (i + 1));
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return { items: out, nextCursor: c };
}

/**
 * 把游标推进 `steps` 步（不取值）。
 *
 * 与逐次调用等价：mulberry32 每次推进就是加一次 `STEP`，故 `n` 次 = `+n*STEP`。
 * reducer 用它应用 `rng:advance` 事件 —— 因为洗牌结果已由事件显式携带，
 * reducer 不需要重算随机，只需把游标推进相同的步数，保持后续取值一致。
 */
export function advanceCursor(cursor: number, steps: number): number {
  return (cursor + Math.imul(steps, STEP)) >>> 0;
}

/** 由字符串种子生成初始游标（同一 seed 必得同一游标）。 */
export function seedFrom(text: string): number {
  let h = 2166136261 >>> 0; // FNV-1a 32 位偏移基
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * 数值种子 → 开局随机游标（D-269 / issue #103）。
 *
 * ## 为什么不用 `seed >>> 0` 直接当游标
 *
 * 服务端的种子来自 `Date.now()`，同一台机器上前后两局的种子常常只差几百毫秒。
 * mulberry32 对**相邻**游标虽然不会退化成同一序列，但 FNV-1a 能把相邻数字彻底打散，
 * 让「隔一分钟再开一局」与「隔一周再开一局」在统计上看不出差别；
 * 顺带也让 `seed = 0` 不会退化成游标 0（那正是 D-269 之前写死的坏值）。
 *
 * ## 唯一入口
 *
 * 「种子怎么变成游标」这条规则**只在这里**。`createInitialState` 与
 * `seedSetup`（写回放用）都调它 —— 两处各算一遍就会变成「双裁决」，
 * 哪天改算法必然只改一处，回放立刻分叉（ADR-0056 的教训）。
 */
export function initialRngCursor(seed: number): number {
  return seedFrom(String(seed));
}
