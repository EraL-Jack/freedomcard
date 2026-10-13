import type { GameEvent, GameState, Intent, Result, Rejection, RuleContext } from '@app/shared';

/**
 * 规则引擎的三个入口。
 *
 * ⚠️ 当前状态：`applyIntent` 与 `reduce` 是 `TODO(slot)` —— 它们的行为完全取决于
 * `docs/06` A 组的规则输入。在 Era 给出规则之前，这里**不得**自行实现任何玩法，
 * 也不得预置「抽牌 / 出牌 / 攻击 / 结束回合」之类的处理器（那是替 Era 发明玩法）。
 *
 * `stateHash` 与玩法无关（只是规范化序列化 + 哈希），因此已实现完整。
 */

/**
 * 校验 Intent 并产出事件。纯函数：禁止 IO / 读时钟 / Math.random()。
 * 不通过时返回 Rejection 且**零副作用**，不存在「改了一半」的中间态。
 */
export function applyIntent(
  _state: GameState,
  _intent: Intent,
  _ctx: RuleContext,
): Result<GameEvent[], Rejection> {
  // TODO(slot): 待 A 组规则输入后，改为查 registry 并调用对应 handler。
  return { ok: false, error: { code: 'NOT_IMPLEMENTED', message: '规则引擎骨架：applyIntent 待 A 组输入后实现' } };
}

/** 用一个事件演进状态。纯函数，不可变更新。 */
export function reduce(state: GameState, _event: GameEvent): GameState {
  // TODO(slot): 待 A 组规则输入后，按事件类型推进（含 rngCursor）。
  return state;
}

/** 规范化序列化：对象键排序、数组保序、undefined 视为缺失。 */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
  }
  return 'null';
}

/**
 * 状态哈希（FNV-1a 32 位，十六进制）。
 * 双端各算一次比对，不一致即 desync。必须对规范化序列化结果计算，否则会产生假 desync。
 */
export function stateHash(state: GameState): string {
  const text = canonicalize(state);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
