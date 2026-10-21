import { RULE_ERRORS } from '@app/shared/constants';
import type { GameEvent, GameState, Intent, Result, Rejection, RuleContext } from '@app/shared/types';

import { get } from './registry.js';
import './rules/index.js';

export { reduce } from './reducer.js';

/**
 * 校验 Intent 并产出事件。纯函数：禁止 IO / 读时钟 / Math.random()。
 *
 * 行为：查注册表 → 调对应 handler。未注册的类型一律 `NOT_IMPLEMENTED`，
 * **不做静默忽略** —— 客户端需要能区分「这条规则还没做」和「这条操作不被允许」。
 *
 * 侧效应为零：不通过时返回 Rejection，不存在「改了一半」的中间态。
 */
export function applyIntent(
  state: GameState,
  intent: Intent,
  ctx: RuleContext,
): Result<GameEvent[], Rejection> {
  // ADR-0023 §2 全局守卫：待定选择挂起期间，玩家 Intent 只放行
  // 「回答选择」与「认输」，其余一律拒绝 —— 防止选择未决时推进阶段导致状态错位。
  // 系统 Intent（超时兜底等）不受此限。
  if (state.pendingChoice && intent.actor === 'player') {
    const allow = intent.type === 'effect:choose' || intent.type === 'game:concede';
    if (!allow) {
      return {
        ok: false,
        error: { code: RULE_ERRORS.PENDING_CHOICE, message: '请先完成当前选择' },
      };
    }
  }
  const handler = get(intent.type);
  if (!handler) {
    return {
      ok: false,
      error: { code: RULE_ERRORS.NOT_IMPLEMENTED, message: `未注册的规则: ${intent.type}` },
    };
  }
  return handler(state, intent, ctx);
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
