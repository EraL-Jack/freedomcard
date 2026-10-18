/**
 * 攻击结算 —— ADR-0013（裁决）+ ADR-0014（指挥官伤害与胜负）。
 *
 * 依据：
 *  - X-3（Era 2026-10-13）：**只比较力量值**。
 *    `atk > def` → 防守方破坏；`atk < def` → 攻击方破坏；`atk == def` → 双方破坏。
 *  - X-4（Era 2026-10-13）：对指挥官造成伤害 → 扣除对应血量 → **血量清空游戏结束**。
 *  - X-5（Era 2026-10-13）：**卡上未写伤害值时，伤害值默认为 1**（与 `power` 无关）。
 *  - A9-2：每个单位每回合攻击 1 次，攻击后进入休眠态，重置阶段清除。
 *  - A10-3：先攻方第一回合不可攻击。
 *  - A7 嘲讽：对手**随从**攻击时必须优先选择嘲讽目标。
 *  - A5 补充 1：指挥官每受 1 点伤害 → 从卡组顶展示 1 张卡（如有效果则触发），
 *    然后置入费用区。
 *
 * **两条不同的路径**（ADR-0014 §1）：
 *  - 打**随从** → 力量值对比 → 输的一方破坏，不掉血（随从没有血量）。
 *  - 打**指挥官** → 力量值对比，防守方输则**扣血**，血空结束；攻击方输则自己破坏、不掉血。
 *
 * `TODO(slot)` 清单（未决，不猜）：
 *  1. `CardDef.damage` 的**取值范围**（上限/是否可为 0）—— 默认值已由 X-5 定为 1，范围未给。
 *  2. 触发效果的**清单**（A7 关键词表待补）。
 *  3. 效果能否取消 / 替换攻击（现按「不能」，ADR-0013 §8）。
 *  4. 展示出来的卡「如有效果则触发对应效果」—— 效果未定义，故只展示不触发。
 */

import {
  DEFAULT_DAMAGE,
  KEYWORD_TAUNT,
  RULE_ERRORS,
  type CardDef,
  type GameEvent,
  type GameState,
  type Intent,
  type Result,
  type Rejection,
  type RuleContext,
} from '@app/shared';

import {
  baseGuard,
  defOf,
  ev,
  firstRejection,
  hasKeyword,
  locate,
  moved,
  phaseGuard,
  reject,
  strArg,
  takeFromDeck,
  unitPower,
} from '../ops.js';
import { opponentOf } from '../state.js';

/** 裁决结果：谁被破坏。 */
export type CombatOutcome = 'defender' | 'attacker' | 'both';

/**
 * 纯力量值比较 —— Era 给的三分支（X-3）。
 *
 * 单独导出是为了让「裁决」这件事可单测、可被后续效果系统复用，
 * 而不必构造一整个对局状态。
 */
export function resolveCombat(atkPower: number, defPower: number): CombatOutcome {
  if (atkPower > defPower) return 'defender';
  if (atkPower < defPower) return 'attacker';
  return 'both';
}

/**
 * 取一张卡的伤害值。
 *
 * X-5（Era 2026-10-13）：**卡上未写伤害值时默认 1**。
 * 写成常量 `DEFAULT_DAMAGE` 而非字面量 —— 这是唯一一处伤害兜底，改名/改值只动一处。
 */
export function damageOf(def: CardDef): number {
  return def.damage ?? DEFAULT_DAMAGE;
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

  const foePlayer = state.players[foe];
  if (!foePlayer) return reject(RULE_ERRORS.NOT_STARTED, '对手不在座');

  // A7 嘲讽：对方场上有嘲讽随从时，目标必须落在嘲讽集合内。
  // 多个嘲讽由攻击方任选其一 —— 「任选」不构成需要裁决的冲突（ADR-0013 §6）。
  const taunts = foePlayer.zones.board.filter((c) => hasKeyword(defOf(ctx.cards, c.defId), KEYWORD_TAUNT));
  if (taunts.length > 0 && !taunts.some((c) => c.uid === targetUid)) {
    return reject(RULE_ERRORS.MUST_ATTACK_TAUNT, '对方存在嘲讽随从，必须优先选择嘲讽目标');
  }

  const atkDef = defOf(ctx.cards, atk.card.defId);
  const defDef = defOf(ctx.cards, tgt.card.defId);
  if (!atkDef || !defDef) {
    return reject(RULE_ERRORS.CARD_NOT_FOUND, '卡池中查不到该卡定义');
  }

  // 力量值快照 —— **必须排在触发之后**（ADR-0013 §7）：
  // 若将来出现「攻击时 +N 力量」的效果，快照在前就会用旧值裁决。
  //
  // ⚠️ 读的是**当前**力量值而非静态 `def.power`（ADR-0016 §8）：指挥官按 X-7 的力量曲线
  //    逐回合成长，若取定义上的初始值，指挥官会永远按第 0 档参战。
  const atkPower = unitPower(state, ctx.cards, attackerUid);
  const defPower = unitPower(state, ctx.cards, targetUid);
  if (atkPower === null || defPower === null) {
    return reject(RULE_ERRORS.CARD_NOT_FOUND, '无法确定该单位的力量值');
  }
  // 伤害值 = 卡面伤害（缺省 1，X-5）+ 本回合临时加成（统领 7 档，ADR-0023 §3）
  const atkDamage = damageOf(atkDef) + (atk.card.tempDamage ?? 0);

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

  const defenderLoses = outcome === 'defender' || outcome === 'both';
  const attackerDies = outcome === 'attacker' || outcome === 'both';
  const targetIsCommander = tgt.zone === 'commander';

  if (defenderLoses && targetIsCommander) {
    // ADR-0014 §1：指挥官不走「破坏」，改为受伤扣血。
    const next = Math.max(0, foePlayer.health - atkDamage); // H15：血量不为负
    events.push(ev(at, 'commander:damaged', { playerId: foe, amount: atkDamage, sourceUid: attackerUid }));

    // A5 补充 1：每 1 点伤害 → 从卡组顶展示 1 张 → 置入费用区（H14：逐点触发，含重复卡）
    const revealed = takeFromDeck(
      at,
      foe,
      { deck: foePlayer.zones.deck, graveyard: foePlayer.zones.graveyard },
      atkDamage,
      state.rngCursor,
      'cost',
      true,
    );
    events.push(...revealed.events);
    // ⚠️ 展示出的卡「如有效果则触发对应效果」—— 效果清单未给，故**只展示不触发**（TODO(slot)）

    events.push(ev(at, 'health:changed', { playerId: foe, value: next, delta: -atkDamage }));
    if (next <= 0) {
      events.push(ev(at, 'game:ended', { winner: me, reason: 'health' }));
    }
  } else if (defenderLoses) {
    events.push(moved(at, tgt.playerId, targetUid, tgt.zone, 'graveyard'));
  }

  if (attackerDies) events.push(moved(at, me, attackerUid, 'board', 'graveyard'));

  // A9-2：攻击后休眠。已被破坏的单位不再标记 —— 对死掉的单位标休眠没有意义。
  // 例外：统领 9 档授予的「攻击后重置」（attackRefresh）置位时不休眠，
  // 但**一回合一次**（H23，Era 2026-10-19 拍板）—— 生效即消耗，本回合第二次攻击照常休眠。
  if (!attackerDies) {
    if (atk.card.attackRefresh) {
      events.push(ev(at, 'unit:modified', { playerId: me, uid: attackerUid, attackRefresh: false }));
    } else {
      events.push(ev(at, 'unit:asleep', { playerId: me, uid: attackerUid }));
    }
  }

  return { ok: true, value: events };
};
