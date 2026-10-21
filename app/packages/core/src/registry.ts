import type { GameEvent, GameState, Intent, Result, Rejection, RuleContext } from '@app/shared/types';

/**
 * 规则注册表 —— 一个机制一个文件，经本表插拔。
 *
 * ⚠️ 当前为空：注册哪些处理器完全由 `docs/06` A 组的规则输入决定。
 * A 组未填前，禁止预置任何 handler（包括但不限于抽牌 / 出牌 / 攻击 / 结束回合）。
 *
 * 扩展判据：新增规则 = 新增文件 + 在表里注册一行。
 * 若某次扩展的 diff 触及了**既有规则文件的内部实现**，视为架构违规，必须重构。
 */

export type RuleHandler = (
  state: GameState,
  intent: Intent,
  ctx: RuleContext,
) => Result<GameEvent[], Rejection>;

export const rules: Record<string, RuleHandler> = {};

export function register(type: string, handler: RuleHandler): void {
  if (rules[type]) {
    throw new Error(`规则重复注册: ${type}`);
  }
  rules[type] = handler;
}

export function get(type: string): RuleHandler | undefined {
  return rules[type];
}
