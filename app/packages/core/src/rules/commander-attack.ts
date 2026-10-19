/**
 * 指挥官攻击 —— docs/16 §6.1 / ADR-0024（§10 差异清单第 10 条）。
 *
 * > 每个己方战斗阶段一次，指挥官对敌方指挥官造成**固定 1 点**伤害。
 * > 不比较力量、不受前排限制、不受自身力量影响。
 *
 * 三条边界：
 *  - 先攻方第一回合不可攻击（A10-3，§6.1）；
 *  - 每回合一次（`PlayerState.commanderAttacked`，`turn:changed` 清零）；
 *  - **不能攻击随从**（§6.2）—— 本规则没有目标参数，目标恒为敌方指挥官。
 *
 * 固定伤害**不吃**任何加成（§9 第 9 条）：统领 7 档的 `tempDamage` 只作用于随从打脸。
 */

import {
  COMMANDER_ATTACK_DAMAGE,
  RULE_ERRORS,
  type GameEvent,
  type GameState,
  type Intent,
  type Result,
  type Rejection,
  type RuleContext,
} from '@app/shared';

import { commanderDamageEvents } from '../combat.js';
import { baseGuard, ev, firstRejection, phaseGuard, reject } from '../ops.js';
import { opponentOf } from '../state.js';

export const commanderAttackRule = (
  state: GameState,
  intent: Intent,
  ctx: RuleContext,
): Result<GameEvent[], Rejection> => {
  const guard = firstRejection(baseGuard(state, intent), phaseGuard(state, 'battle'));
  if (guard) return { ok: false, error: guard };

  const me = intent.playerId;
  const foe = opponentOf(state, me);
  if (!foe) return reject(RULE_ERRORS.NOT_STARTED, '对手不在座');

  if (state.turn === 1 && state.activeSeat === 0) {
    return reject(RULE_ERRORS.CANNOT_ATTACK, '先攻方第一回合不可攻击');
  }
  const p = state.players[me];
  if (!p) return reject(RULE_ERRORS.NOT_STARTED, '玩家不在本局');
  if (p.commanderAttacked) {
    return reject(RULE_ERRORS.COMMANDER_ATTACK_USED, '指挥官本回合已经攻击过');
  }
  const cmdUid = p.zones.commander[0]?.uid;
  if (!cmdUid) return reject(RULE_ERRORS.CARD_NOT_FOUND, '指挥官尚未揭示');

  const at = ctx.now;
  const events: GameEvent[] = [
    ev(at, 'commander:attacked', { playerId: me, sourceUid: cmdUid, targetPlayer: foe }),
    ...commanderDamageEvents(at, state, foe, COMMANDER_ATTACK_DAMAGE, cmdUid, me),
  ];
  return { ok: true, value: events };
};
