/**
 * 随从攻击 —— docs/16 §5（8 血版，ADR-0024）+ ADR-0013 / ADR-0014 / ADR-0025。
 *
 * 现行口径：
 *  - **只能随从攻击**（指挥官攻击走 `commander-attack.ts`）；目标为对方随从或对方指挥官。
 *  - **前排规则**（§5.2）：对方随从区有随从时，不能宣告攻击其指挥官。
 *  - **打脸门槛**（§5.5）：攻击者力量 ≥ 敌方指挥官当前力量才能宣告。
 *  - **打脸伤害**（§5.5）：按攻击者力量分档 1/2/3；卡面 `damage` 例外覆盖。
 *  - 随从对随从：纯力量三分支（X-3），不掉血。
 *  - 嘲讽优先于前排与任选（A7 / §8）。
 *  - 攻击后休眠（A9-2）；统领 9 档的 `attackRefresh` 生效一次即消耗（H23）。
 *
 * 卡牌钩子（ADR-0025）：
 *  - 霜律戍卫：被攻击时攻击者本回合力量 −1（先于力量快照）；
 *  - 霜律长枪兵：攻击霜冻目标时本次攻击 +2（一次性，不落状态）；
 *  - 炎刃骑士：攻击时可除外墓地一张炎刃卡，换取本回合 +1 —— 需要选择，
 *    因此攻击被拆成「挂起选择 → 回答后结算」两段（`resolveAttackEvents` 可复用）。
 */

import {
  KEYWORD_TAUNT,
  RULE_ERRORS,
  type CardDef,
  type GameEvent,
  type GameState,
  type Intent,
  type PlayerId,
  type Result,
  type Rejection,
  type RuleContext,
} from '@app/shared';
import { isBladeCard } from '@app/shared/cards';

import { commanderDamageEvents } from '../combat.js';
import {
  baseGuard,
  defOf,
  ev,
  faceDamageOf,
  firstRejection,
  hasKeyword,
  locate,
  moved,
  phaseGuard,
  reject,
  strArg,
  unitPower,
} from '../ops.js';
import { opponentOf } from '../state.js';
import { choicePending } from '../effects/index.js';

/** 裁决结果：谁被破坏。 */
export type CombatOutcome = 'defender' | 'attacker' | 'both';

/** 纯力量值比较 —— Era 给的三分支（X-3）。 */
export function resolveCombat(atkPower: number, defPower: number): CombatOutcome {
  if (atkPower > defPower) return 'defender';
  if (atkPower < defPower) return 'attacker';
  return 'both';
}

/** 已通过全部前置校验的攻击上下文。 */
export interface AttackPlan {
  me: PlayerId;
  foe: PlayerId;
  attackerUid: string;
  targetUid: string;
}

/** 骑士选择挂起时，meta 里要带回的攻击上下文。 */
export function attackChoice(
  at: number,
  me: PlayerId,
  attackerUid: string,
  targetUid: string,
  options: string[],
): GameEvent {
  return choicePending(at, {
    playerId: me,
    kind: 'blade-knight-attack',
    sourceUid: attackerUid,
    options,
    meta: { attackerUid, targetUid },
  });
}

/**
 * **结算一次已宣告的攻击**（不再重复前置校验；供攻击规则与骑士的 choose 共用）。
 *
 * `extraPower` 只作用于本次攻击（骑士 +1 同时也会写 tempPower，二者相加不冲突：
 * 调用方传 0 或 1，与已写入状态的 tempPower 无关 —— 这里用参数是为了「回答选择的
 * 那一刻」就能参与裁决，而不必等事件落地）。
 */
export function resolveAttackEvents(
  state: GameState,
  ctx: RuleContext,
  plan: AttackPlan,
  extraPower = 0,
): GameEvent[] {
  const { me, foe, attackerUid, targetUid } = plan;
  const at = ctx.now;
  const atk = locate(state, attackerUid);
  const tgt = locate(state, targetUid);
  if (!atk || !tgt) return [];
  const atkDef = defOf(ctx.cards, atk.card.defId);
  const defDef = defOf(ctx.cards, tgt.card.defId);
  if (!atkDef || !defDef) return [];

  const events: GameEvent[] = [];
  const basePower = unitPower(state, ctx.cards, attackerUid) ?? 0;
  let atkPower = basePower + extraPower;

  // 霜律戍卫：被攻击时攻击者本回合 −1（先于快照；同时落状态供本回合后续攻击使用）。
  // 每次被攻击都触发，力量下限由 unitPower 的 0 下限兜底（这里只做本次修正）。
  if (defDef.defId === 'frostWarden') {
    events.push(ev(at, 'unit:modified', { playerId: me, uid: attackerUid, tempPower: -1 }));
    atkPower = Math.max(0, atkPower - 1);
  }
  // 霜律长枪兵：攻击霜冻目标 +2（一次性）。
  if (atkDef.defId === 'frostLancer' && tgt.card.frozen) {
    atkPower += 2;
  }

  const defPower = unitPower(state, ctx.cards, targetUid) ?? 0;
  const atkDamage = faceDamageOf(atkDef, atkPower) + (atk.card.tempDamage ?? 0);

  const targetIsCommander = tgt.zone === 'commander';
  // docs/16 §5.5（D-227 修订）：打脸不再是力量对拼 —— 只要前排为空，
  // 任意随从宣告即直接结算伤害，不比较力量、攻击方也不会自爆。
  const outcome: CombatOutcome = targetIsCommander ? 'defender' : resolveCombat(atkPower, defPower);
  events.push(ev(at, 'attack:declared', { by: me, attackerUid, targetUid }));
  events.push(ev(at, 'trigger:attack', { by: me, uid: attackerUid }));
  events.push(ev(at, 'trigger:defend', { by: me, uid: targetUid }));
  events.push(ev(at, 'combat:resolved', { by: me, attackerUid, targetUid, atkPower, defPower, outcome }));

  const defenderLoses = outcome === 'defender' || outcome === 'both';
  const attackerDies = !targetIsCommander && (outcome === 'attacker' || outcome === 'both');

  if (targetIsCommander) {
    // ADR-0014 / docs/16 §5.5：指挥官受伤扣血；伤害值由力量分档决定。
    events.push(...commanderDamageEvents(at, state, foe, atkDamage, attackerUid, me));
  } else if (defenderLoses) {
    events.push(moved(at, tgt.playerId, targetUid, tgt.zone, 'graveyard'));
  }

  if (attackerDies) events.push(moved(at, me, attackerUid, 'board', 'graveyard'));

  // A9-2：攻击后休眠；统领 9 档的「一回合一次，攻击后重置」生效即消耗（H23）。
  if (!attackerDies) {
    if (atk.card.attackRefresh) {
      events.push(ev(at, 'unit:modified', { playerId: me, uid: attackerUid, attackRefresh: false }));
    } else {
      events.push(ev(at, 'unit:asleep', { playerId: me, uid: attackerUid }));
    }
  }
  return events;
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
  if (!foe) return reject(RULE_ERRORS.NOT_STARTED, '对手不在座');

  // A10-3 / docs/16 §5.1：先攻方第一回合不可攻击。
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

  const atkDef = defOf(ctx.cards, atk.card.defId);
  if (!atkDef) return reject(RULE_ERRORS.CARD_NOT_FOUND, '卡池中查不到该卡定义');

  const targetIsCommander = tgt.zone === 'commander';

  // docs/16 §5.2 前排规则：对方随从区有随从时不能打脸（不分休眠与否，§9 第 2 条）。
  if (targetIsCommander && foePlayer.zones.board.length > 0) {
    return reject(RULE_ERRORS.FRONT_LINE, '对方随从区有随从，必须先攻击随从');
  }

  // A7 嘲讽：对方有嘲讽随从时必须优先选嘲讽（对随从目标生效；打脸已被前排挡住）。
  if (!targetIsCommander) {
    const taunts = foePlayer.zones.board.filter((c) => hasKeyword(defOf(ctx.cards, c.defId), KEYWORD_TAUNT));
    if (taunts.length > 0 && !taunts.some((c) => c.uid === targetUid)) {
      return reject(RULE_ERRORS.MUST_ATTACK_TAUNT, '对方存在嘲讽随从，必须优先选择嘲讽目标');
    }
  }

  // docs/16 §5.5（D-227 修订）：**已删除打脸力量门槛** —— 前排为空时任何随从
  // 都能宣告打脸，直接结算伤害，不比较力量、攻击方不自爆。

  // 炎刃骑士：攻击时可除外墓地一张炎刃卡换本回合 +1 —— 需要选择，先挂起。
  // （这是目前唯一需要「攻击前选择」的卡；新增同类卡时改成走 effects 注册表的钩子。）
  if (atkDef.defId === 'bladeKnight') {
    const gy = playerGraveyardBlade(state, me, ctx.cards);
    if (gy.length > 0) {
      return { ok: true, value: [attackChoice(ctx.now, me, attackerUid, targetUid, gy)] };
    }
  }

  return { ok: true, value: resolveAttackEvents(state, ctx, { me, foe, attackerUid, targetUid }) };
};

/** 墓地里的炎刃卡 uid 列表（骑士 / 老兵 / 凤凰共用判定口径）。 */
export function playerGraveyardBlade(
  state: GameState,
  playerId: PlayerId,
  cards: Record<string, CardDef>,
): string[] {
  const p = state.players[playerId];
  if (!p) return [];
  return p.zones.graveyard
    .filter((c) => {
      const def = cards[c.defId];
      return def !== undefined && isBladeCard(def);
    })
    .map((c) => c.uid);
}
