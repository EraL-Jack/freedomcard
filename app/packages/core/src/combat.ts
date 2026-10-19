/**
 * 指挥官受伤的公共链路 —— 随从打脸、指挥官攻击、法术直伤共用（ADR-0024）。
 *
 * 口径（docs/16 §5.7 / A5 补充 1）：每 1 点伤害 → 从卡组顶**展示** 1 张 → 置入费用区。
 * 逐点触发；展示出的卡不结算效果（效果清单已由 docs/12 给出，但「受伤展示」仍只展示，
 * 因为卡面没有「从卡组展示时」的触发 —— 斥候除外，它只在自己的展示时机生效）。
 */

import type { GameEvent, GameState, PlayerId } from '@app/shared';

import { ev, takeFromDeck } from './ops.js';

/**
 * 对指挥官造成 `amount` 点伤害，返回完整事件批（含受伤展示、血量、可能的终局）。
 * `amount <= 0` 返回空数组。
 */
export function commanderDamageEvents(
  at: number,
  state: GameState,
  targetId: PlayerId,
  amount: number,
  sourceUid: string,
  winnerIfLethal: PlayerId,
): GameEvent[] {
  if (amount <= 0) return [];
  const p = state.players[targetId];
  if (!p) return [];

  const events: GameEvent[] = [];
  events.push(ev(at, 'commander:damaged', { playerId: targetId, amount, sourceUid }));

  // A5 补充 1：逐点展示 → 费用区（H14）
  const revealed = takeFromDeck(
    at,
    targetId,
    { deck: p.zones.deck, graveyard: p.zones.graveyard },
    amount,
    state.rngCursor,
    'cost',
    true,
  );
  events.push(...revealed.events);

  const next = Math.max(0, p.health - amount); // H15：血量不为负
  events.push(ev(at, 'health:changed', { playerId: targetId, value: next, delta: -amount }));
  if (next <= 0) {
    events.push(ev(at, 'game:ended', { winner: winnerIfLethal, reason: 'health' }));
  }
  return events;
}
