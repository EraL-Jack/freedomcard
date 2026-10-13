/**
 * 攻击结算 —— ADR-0013。
 *
 * 依据：
 *  - Era 2026-10-13 裁决输入：**只比较力量值**。
 *    `atk > def` → 防守方破坏；`atk < def` → 攻击方破坏；`atk == def` → 双方破坏。
 *  - A9-2：每个单位每回合攻击 1 次，攻击后进入休眠态，重置阶段清除。
 *  - A10-3：先攻方第一回合不可攻击。
 *  - A7 嘲讽：对手**随从**攻击时必须优先选择嘲讽目标。
 *  - Era 同批输入：攻击时与被攻击时都可能有触发效果。
 *
 * ⚠️ 本文件**不引入生命值**，也**不扣血**。理由见 ADR-0013 §1 / §4：
 * 裁决式子里没有伤害数值的位置，A3-1 唯一判负条件是血空而 Era 未给
 * 「一次攻击造成多少伤害」，故这部分一律 `TODO(slot)`，不替 Era 发明。
 *
 * `TODO(slot)` 清单（未决，不猜）：
 *  1. 指挥官被破坏是否判负（A3-1 只承认血空）。本实现**只破坏不判负**。
 *  2. 攻击是否掉血、掉多少；`CardDef.damage` 的含义与取值范围。
 *  3. 触发效果的**清单**（A7 关键词表待 Era 补充）。
 *  4. 效果能否取消 / 替换攻击（现按「不能」处理，见 ADR-0013 §8）。
 */

import {
  KEYWORD_TAUNT,
  RULE_ERRORS,
  type GameEvent,
  type GameState,
  type Intent,
  type Result,
  type Rejection,
  type RuleContext,
} from '@app/shared';

import {
  baseGuard,
  ev,
  firstRejection,
  hasKeyword,
  locate,
  moved,
  phaseGuard,
  powerOf,
  reject,
  strArg,
} from '../ops.js';
import { opponentOf } from '../state.js';

/** 裁决结果：谁被破坏。 */
export type CombatOutcome = 'defender' | 'attacker' | 'both';

/**
 * 纯力量值比较 —— Era 给的三分支。
 *
 * 单独导出是为了让「裁决」这件事可单测、可被后续效果系统复用，
 * 而不必构造一整个对局状态。
 */
export function resolveCombat(atkPower: number, defPower: number): CombatOutcome {
  if (atkPower > defPower) return 'defender';
  if (atkPower < defPower) return 'attacker';
  return 'both';
}

export const attackRule = (
  state: GameState,
  intent: Intent,
  ctx: RuleContext,
): Result<GameEvent[], Rejection> => {
  const guard = firstRejection(baseGuard(state, intent), phaseGuard(state, 'battle'));
  if (guard) return { ok: false, error: guard };

  const me = intent.playerId;
  const foe = opponentOf(state, me);
  if (!foe) {
    return reject(RULE_ERRORS.NOT_STARTED, '对手不在座');
  }

  // A10-3：先攻方第一回合不可攻击。口径与 `phase.ts` 的首回合抽 1 张保持一致。
  if (state.turn === 1 && state.activeSeat === 0) {
    return reject(RULE_ERRORS.CANNOT_ATTACK, '先攻方第一回合不可攻击');
  }

  const attackerUid = strArg(intent.payload?.['attackerUid']);
  const targetUid = strArg(intent.payload?.['targetUid']);
  if (!attackerUid || !targetUid) {
    return reject(RULE_ERRORS.CARD_NOT_FOUND, '缺少 attackerUid / targetUid');
  }

  const atk = locate(state, attackerUid);
  const tgt = locate(state, targetUid);
  if (!atk || !tgt) return reject(RULE_ERRORS.CARD_NOT_FOUND, '找不到该单位');
  if (atk.playerId !== me) return reject(RULE_ERRORS.INVALID_TARGET, '只能用己方单位攻击');
  if (atk.zone !== 'board') return reject(RULE_ERRORS.CARD_NOT_IN_ZONE, '攻击方必须位于随从区');
  if (atk.card.sleeping) return reject(RULE_ERRORS.UNIT_ASLEEP, '该单位已攻击过，处于休眠态');
  if (tgt.playerId !== foe) return reject(RULE_ERRORS.INVALID_TARGET, '不能攻击己方单位');
  if (tgt.zone !== 'board' && tgt.zone !== 'commander') {
    return reject(RULE_ERRORS.INVALID_TARGET, '目标只能是对方随从或指挥官');
  }

  // A7 嘲讽：对方场上有嘲讽随从时，目标必须落在嘲讽集合内。
  // 多个嘲讽由攻击方任选其一 —— 「任选」不构成需要裁决的冲突（ADR-0013 §6）。
  const foePlayer = state.players[foe];
  if (foePlayer) {
    const taunts = foePlayer.zones.board.filter((c) => hasKeyword(ctx.cards[c.defId], KEYWORD_TAUNT));
    if (taunts.length > 0 && !taunts.some((c) => c.uid === targetUid)) {
      return reject(RULE_ERRORS.MUST_ATTACK_TAUNT, '对方存在嘲讽随从，必须优先选择嘲讽目标');
    }
  }

  // 力量值快照 —— **必须排在触发之后**（ADR-0013 §7）：
  // 若将来出现「攻击时 +N 力量」的效果，快照在前就会用旧值裁决。
  const atkPower = powerOf(ctx.cards, atk.card.defId);
  const defPower = powerOf(ctx.cards, tgt.card.defId);
  if (atkPower === null || defPower === null) {
    return reject(RULE_ERRORS.CARD_NOT_FOUND, '卡池中查不到该卡定义');
  }

  const outcome = resolveCombat(atkPower, defPower);
  const at = ctx.now;
  const events: GameEvent[] = [];

  events.push(ev(at, 'attack:declared', { by: me, attackerUid, targetUid }));
  // 触发点：本批不结算任何效果（A7 效果清单未给），只产出事件供后续效果系统挂载。
  events.push(ev(at, 'trigger:attack', { by: me, uid: attackerUid }));
  events.push(ev(at, 'trigger:defend', { by: me, uid: targetUid }));
  events.push(
    ev(at, 'combat:resolved', { by: me, attackerUid, targetUid, atkPower, defPower, outcome }),
  );

  const defenderDies = outcome === 'defender' || outcome === 'both';
  const attackerDies = outcome === 'attacker' || outcome === 'both';
  if (defenderDies) events.push(moved(at, tgt.playerId, targetUid, tgt.zone, 'graveyard'));
  if (attackerDies) events.push(moved(at, me, attackerUid, 'board', 'graveyard'));

  // A9-2：攻击后休眠。已被破坏的单位不再标记 —— 对死掉的单位标休眠没有意义。
  if (!attackerDies) events.push(ev(at, 'unit:asleep', { playerId: me, uid: attackerUid }));

  // ⚠️ 此处**不产出** `game:ended`：指挥官被破坏是否判负 Era 未给（ADR-0013 §5）。
  return { ok: true, value: events };
};
