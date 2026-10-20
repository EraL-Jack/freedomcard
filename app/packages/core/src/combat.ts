/**
 * 指挥官受伤的公共链路 —— 随从打脸、指挥官攻击、法术直伤共用（ADR-0024）。
 *
 * 口径（docs/16 §5.7 / A5 补充 1，D-234 修订）：每 1 点伤害 → 从卡组顶**展示** 1 张 →
 * 置入费用区。逐点触发；**展示就是展示** —— 走与技能展示完全相同的动作
 * （`revealAction`），因此同样触发星轨 +1 与「展示时」效果（Era 2026-10-21）。
 */

import type { GameEvent, GameState, PlayerId, RuleContext } from '@app/shared';

import { revealAction } from './effects/index.js';
import { ev } from './ops.js';

/**
 * 对指挥官造成 `amount` 点伤害，返回完整事件批（含受伤展示、血量、可能的终局）。
 * `amount <= 0` 返回空数组。
 *
 * `ctx` 必需：受伤展示会触发「展示时」效果（星轨弓手直伤、织者召唤、侍僧加伤…），
 * 派发这些效果需要卡池与时间戳。
 */
export function commanderDamageEvents(
  at: number,
  state: GameState,
  targetId: PlayerId,
  amount: number,
  sourceUid: string,
  winnerIfLethal: PlayerId,
  ctx: RuleContext,
): GameEvent[] {
  if (amount <= 0) return [];
  const p = state.players[targetId];
  if (!p) return [];

  const events: GameEvent[] = [];
  events.push(ev(at, 'commander:damaged', { playerId: targetId, amount, sourceUid }));

  // A5 补充 1 / H14：逐点展示 → 费用区。逐点而非一次性，是因为「展示时」效果
  // 可能改变牌序（抽牌、洗回），第二张「卡组顶」未必是原本的第二张。
  let cur = state;
  for (let i = 0; i < amount; i++) {
    const r = revealAction(at, cur, targetId, ctx, {
      n: 1,
      reason: 'commander-damage',
      settle: 'cost',
    });
    events.push(...r.events);
    cur = r.state;
  }

  // H15：血量不为负。
  //
  // D-237（Era 2026-10-21）：即死模式下**掉血即判负** —— 不论伤害几点，血量直接归零。
  // 判负仍走「血量归零」这条既有链路（`health:changed` + `game:ended`），
  // 只是 reason 换成 `'sudden-death'`，让结算面板能说清「是在即死模式里被打死的」。
  const next = state.suddenDeath ? 0 : Math.max(0, p.health - amount);
  events.push(ev(at, 'health:changed', { playerId: targetId, value: next, delta: -amount }));
  if (next <= 0) {
    events.push(
      ev(at, 'game:ended', {
        winner: winnerIfLethal,
        reason: state.suddenDeath ? 'sudden-death' : 'health',
      }),
    );
  }
  return events;
}
