/**
 * 指挥官攻击 —— docs/16 §6.1 / ADR-0024（§10 差异清单第 10 条）。
 *
 * > 每个己方战斗阶段一次，指挥官对敌方指挥官造成 **1 点**伤害（基础值）。
 * > 不比较力量、不受前排限制、不受自身力量影响。
 *
 * 三条边界：
 *  - 先攻方第一回合不可攻击（A10-3，§6.1）；
 *  - 每回合一次（`PlayerState.commanderAttacked`，`turn:changed` 清零）；
 *  - **不能攻击随从**（§6.2）—— 本规则没有目标参数，目标恒为敌方指挥官。
 *
 * 基础值**可被伤害加成类效果提升**（docs/16 §9 第 9 条，Era 2026-10-19 拍板；H34 已确认）：
 * 伤害 = `COMMANDER_ATTACK_DAMAGE` + `PlayerState.commanderDamageBonus`。
 * 目前唯一来源是**星轨侍僧**「本回合你的指挥官伤害值 +1」（docs/17，不可叠加）。
 * 边界：随从实例上的 `tempDamage`（统领 7 档「选择 1 个己方随从，本回合对指挥官伤害 +1」）
 * 是**该随从打脸**的修正，语义上不转移给指挥官；「造成 N 点伤害」类固定直伤（星陨）也不吃加成。
 *
 * `payload.reveal = true` 时先结算指挥官的「攻击时」效果（星轨观测者：付 1 费展示），
 * **再**结算伤害 —— 顺序保证「展示时：本回合指挥官伤害 +1」能吃到这一次攻击。
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
import { EFFECTS } from '../effects/index.js';
import { baseGuard, defOf, ev, firstRejection, phaseGuard, reject } from '../ops.js';
import { reduce } from '../reducer.js';
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
  const cmd = p.zones.commander[0];
  if (!cmd) return reject(RULE_ERRORS.CARD_NOT_FOUND, '指挥官尚未揭示');

  const at = ctx.now;
  const events: GameEvent[] = [
    ev(at, 'commander:attacked', { playerId: me, sourceUid: cmd.uid, targetPlayer: foe }),
  ];

  // 指挥官「攻击时」效果（星轨观测者 Ⅰ）：先展示、后伤害（docs/17 §6.1）。
  const wantsReveal = intent.payload?.['reveal'] === true;
  let pre: GameEvent[] = [];
  if (wantsReveal) {
    const mod = defOf(ctx.cards, cmd.defId);
    const hook = mod ? EFFECTS[mod.defId]?.onCommanderAttack : undefined;
    if (!hook) {
      return reject(RULE_ERRORS.EFFECT_UNAVAILABLE, '该指挥官没有「攻击时」效果');
    }
    const r = hook(state, intent, ctx);
    if (!r.ok) return r;
    pre = r.value;
    events.push(...pre);
  }

  // 前置效果可能已经打空对手血量（展示触发的直伤）—— 那就到此为止，
  // 不再补一次基础伤害（1 + 加成），避免重复结算终局。
  const afterPre = pre.reduce(reduce, state);
  if (afterPre.winner !== null || afterPre.draw) return { ok: true, value: events };

  const damage = COMMANDER_ATTACK_DAMAGE + (afterPre.players[me]?.commanderDamageBonus ?? 0);
  events.push(...commanderDamageEvents(at, afterPre, foe, damage, cmd.uid, me));
  return { ok: true, value: events };
};
