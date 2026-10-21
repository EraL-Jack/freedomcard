/**
 * 炎刃军统领（bladeLord）的效果 Ⅰ / Ⅱ —— ADR-0023 §5。
 *
 * 卡面原文（docs/10 转录）：
 *  Ⅰ 【2】每回合一次，可以根据除外区的卡名包含炎刃的卡的数量执行以下最多3个效果，每个效果最多一次：
 *    1个：从弃牌区选择一个力量值在除外区炎刃数量等级以下的随从，召唤
 *    3个：选择一个随从，本回合力量值+1
 *    5个：选择一个力量值在除外区炎刃数量等级以下的随从，破坏
 *    7个：选择一个随从，本回合对指挥官伤害+1
 *    9个：选择一个随从，一回合一次，攻击后重置（Era 2026-10-19 修订描述）
 *  Ⅱ 每回合一次，可以将一张手牌除外。
 *
 * 口径（Era 2026-10-18 授权时给定，2026-10-19 拍板修订）：
 *  - 【2】 = 从费用区支付 2 张卡（与出牌支付同路径）；
 *  - 「每回合一次」在自己回合开始时重置（reducer 在进入己方充能阶段清 `effectsUsed`）；
 *  - 「选择一个随从」需要目标选择 → `pendingChoice`；
 *  - 「选择一个随从」：增益类（3/7/9 档）**限己方**（H22）；破坏类（5 档）**双方场上**
 *    （Era 2026-10-21 issue #105 修订 —— 破坏只给己方等于只能自杀）；
 *  - 9 档「攻击后重置」**一回合一次**，生效一次即消耗（H23，Era 2026-10-19 拍板）。
 */

import { BOARD_SLOTS, RULE_ERRORS } from '@app/shared/constants';
import type { GameEvent, GameState, PendingChoice, RuleContext } from '@app/shared/types';

import { baseGuard, ev, firstRejection, locate, moved, playerOf, reject, strArg } from '../ops.js';
import { enemyBoard } from './primitives.js';

import {
  bladeExileCount,
  choiceCleared,
  choicePending,
  commanderSkillCost,
  effectKey,
  payCostCards,
  summonEntryEvents,
  usedGuard,
  type EffectModule,
} from './index.js';

/** 子效果编号 → 解锁所需除外区炎刃数。 */
const LEVELS = { l1: 1, l3: 3, l5: 5, l7: 7, l9: 9 } as const;
type SubId = keyof typeof LEVELS;

/** 一次发动最多执行的子效果数（卡面：最多3个）。 */
const MAX_PICKS = 3;

interface MenuMeta {
  /** 本次发动已选过的子效果（每项最多一次）。 */
  used: SubId[];
  /** 剩余可选次数。 */
  remaining: number;
}

function unlocked(bladeCount: number): SubId[] {
  return (Object.keys(LEVELS) as SubId[]).filter((k) => bladeCount >= LEVELS[k]);
}

function menuMeta(pending: PendingChoice): MenuMeta {
  const m = pending.meta ?? {};
  return {
    used: (Array.isArray(m['used']) ? m['used'] : []) as SubId[],
    remaining: typeof m['remaining'] === 'number' ? m['remaining'] : MAX_PICKS,
  };
}

function menuChoice(
  at: number,
  state: GameState,
  ctx: RuleContext,
  sourceUid: string,
  meta: MenuMeta,
): GameEvent {
  const p = playerOf(state, pendingPlayer(state, sourceUid));
  const bladeCount = p ? bladeExileCount(p, ctx.cards) : 0;
  // 可选子效果 = 已解锁 ∧ 未选过；1 档还要求弃牌区里有合法随从且随从区有空位
  const options = unlocked(bladeCount).filter((id) => {
    if (meta.used.includes(id)) return false;
    if (id === 'l1' && p) {
      return (
        p.zones.board.length < BOARD_SLOTS &&
        p.zones.graveyard.some((c) => {
          const def = ctx.cards[c.defId];
          return def?.type === 'minion' && def.power <= bladeCount;
        })
      );
    }
    return true;
  });
  if (options.length === 0) return choiceCleared(at); // 无可选项直接收尾，不弹空菜单
  return choicePending(at, {
    playerId: pendingPlayer(state, sourceUid),
    kind: 'blade-lord-1',
    sourceUid,
    options,
    meta: { used: meta.used, remaining: meta.remaining },
  });
}

function pendingPlayer(state: GameState, fallbackUid: string): string {
  // 菜单属于发动者 —— 从来源卡反查持有者
  const loc = locate(state, fallbackUid);
  return loc?.playerId ?? state.pendingChoice?.playerId ?? '';
}

export const bladeLordEffect: EffectModule = {
  activate(state, intent, ctx, effectId) {
    const at = ctx.now;
    const me = intent.playerId;
    const loc = locate(state, strArg(intent.payload?.['uid']) ?? '');
    if (!loc || loc.playerId !== me || loc.zone !== 'commander') {
      return reject(RULE_ERRORS.CARD_NOT_IN_ZONE, '效果来源必须是你的指挥官');
    }
    const p = playerOf(state, me);
    if (!p) return reject(RULE_ERRORS.NOT_YOUR_TURN, '玩家不在本局');

    if (effectId === '2') {
      // Ⅱ：将一张手牌除外
      const g = usedGuard(p, loc.card.uid, '2');
      if (g) return { ok: false, error: g };
      if (p.zones.hand.length === 0) {
        return reject(RULE_ERRORS.EFFECT_UNAVAILABLE, '没有可除外手牌');
      }
      return {
        ok: true,
        value: [
          ev(at, 'effect:used', { playerId: me, key: effectKey(loc.card.uid, '2') }),
          choicePending(at, {
            playerId: me,
            kind: 'blade-lord-2',
            sourceUid: loc.card.uid,
            options: p.zones.hand.map((c) => c.uid),
          }),
        ],
      };
    }

    if (effectId !== '1') {
      return reject(RULE_ERRORS.EFFECT_UNAVAILABLE, `未知效果: ${effectId}`);
    }

    // Ⅰ：支付【2】+ 按除外区炎刃数解锁档位
    const g1 = firstRejection(baseGuard(state, intent), usedGuard(p, loc.card.uid, '1'));
    if (g1) return { ok: false, error: g1 };
    const bladeCount = bladeExileCount(p, ctx.cards);
    const open = unlocked(bladeCount);
    if (open.length === 0) {
      return reject(RULE_ERRORS.EFFECT_UNAVAILABLE, '除外区没有「炎刃」卡，档位不足');
    }
    const pay = payCostCards(at, me, p, commanderSkillCost(p));
    if (!Array.isArray(pay)) return { ok: false, error: pay };

    return {
      ok: true,
      value: [
        ...pay,
        ev(at, 'effect:used', { playerId: me, key: effectKey(loc.card.uid, '1') }),
        choicePending(at, {
          playerId: me,
          kind: 'blade-lord-1',
          sourceUid: loc.card.uid,
          options: open,
          meta: { used: [], remaining: MAX_PICKS },
        }),
      ],
    };
  },

  choose(state, intent, ctx, pending) {
    const at = ctx.now;
    const choice = strArg(intent.payload?.['choice']) ?? '';
    const me = intent.playerId;

    // Ⅱ：选一张手牌除外
    if (pending.kind === 'blade-lord-2') {
      if (choice !== 'pass' && !pending.options.includes(choice)) {
        return reject(RULE_ERRORS.INVALID_CHOICE, '不在可选范围');
      }
      if (choice === 'pass') return { ok: true, value: [choiceCleared(at)] };
      return {
        ok: true,
        value: [moved(at, me, choice, 'hand', 'exile'), choiceCleared(at)],
      };
    }

    const meta = menuMeta(pending);

    // 菜单层：选子效果或 pass
    if (pending.kind === 'blade-lord-1') {
      if (choice === 'pass' || meta.remaining <= 0) {
        return { ok: true, value: [choiceCleared(at)] };
      }
      if (!pending.options.includes(choice)) {
        return reject(RULE_ERRORS.INVALID_CHOICE, '该效果未解锁或已选用过');
      }
      const sub = choice as SubId;
      const p = playerOf(state, me);
      if (!p) return reject(RULE_ERRORS.NOT_YOUR_TURN, '玩家不在本局');
      const bladeCount = bladeExileCount(p, ctx.cards);

      // 计算目标候选；不需要目标的子效果直接结算
      const targets = targetCandidates(state, ctx, sub, bladeCount, me);
      if (targets.length === 0) {
        return reject(RULE_ERRORS.INVALID_CHOICE, '没有合法目标');
      }
      return {
        ok: true,
        value: [
          choicePending(at, {
            playerId: me,
            kind: 'blade-lord-1-target',
            sourceUid: pending.sourceUid,
            options: targets,
            meta: { used: [...meta.used, sub], remaining: meta.remaining - 1, sub },
          }),
        ],
      };
    }

    // 目标层：选卡结算，然后回到菜单（还有次数且有可选项时）或结束
    const sub = strArg(pending.meta?.['sub']) as SubId | null;
    if (!sub) return reject(RULE_ERRORS.INVALID_CHOICE, '选择上下文缺失');
    if (choice === 'pass' || !pending.options.includes(choice)) {
      // 目标层 pass = 放弃这个子效果：已计入 used 的撤销（回到菜单时该效果仍可再选）
      const back: MenuMeta = { used: meta.used.filter((x) => x !== sub), remaining: meta.remaining + 1 };
      return { ok: true, value: [menuChoice(at, state, ctx, pending.sourceUid, back)] };
    }

    const events: GameEvent[] = [];
    switch (sub) {
      case 'l1': {
        // 从弃牌区召唤到随从区
        events.push(moved(at, me, choice, 'graveyard', 'board'));
        // 登场触发器 + 登场效果（H28：需要选择的部分排队，等统领菜单结算完再触发）。
        events.push(...summonEntryEvents(at, state, me, choice, ctx));
        break;
      }
      case 'l3':
        events.push(ev(at, 'unit:modified', { playerId: locate(state, choice)!.playerId, uid: choice, tempPower: 1 }));
        break;
      case 'l5': {
        const tgt = locate(state, choice)!;
        events.push(moved(at, tgt.playerId, choice, 'board', 'graveyard'));
        break;
      }
      case 'l7':
        events.push(ev(at, 'unit:modified', { playerId: locate(state, choice)!.playerId, uid: choice, tempDamage: 1 }));
        break;
      case 'l9':
        events.push(ev(at, 'unit:modified', { playerId: locate(state, choice)!.playerId, uid: choice, attackRefresh: true }));
        break;
    }

    // 回到菜单（若还有次数）或收尾
    const nextMeta: MenuMeta = { used: meta.used, remaining: meta.remaining };
    if (nextMeta.remaining > 0) {
      events.push(menuChoice(at, state, ctx, pending.sourceUid, nextMeta));
    } else {
      events.push(choiceCleared(at));
    }
    return { ok: true, value: events };
  },
};

/** 子效果的目标候选计算。 */
function targetCandidates(
  state: GameState,
  ctx: RuleContext,
  sub: SubId,
  bladeCount: number,
  me: string,
): string[] {
  const p = playerOf(state, me);
  if (!p) return [];
  // H22（Era 2026-10-19 拍板，2026-10-21 按 issue #105 修订）：
  // 「选择一个随从」中**增益类**（3/7/9 档）限己方；**破坏类**（5 档）候选是双方场上。
  const ownBoard = p.zones.board.map((c) => ({ uid: c.uid, defId: c.defId }));
  const withinBlade = (list: readonly { uid: string; defId: string }[]): string[] =>
    list
      .filter((c) => {
        const def = ctx.cards[c.defId];
        return def !== undefined && def.power <= bladeCount;
      })
      .map((c) => c.uid);
  switch (sub) {
    case 'l1':
      // 弃牌区里的随从，力量值 ≤ 除外区炎刃数（弃牌区卡无临时修正，取卡面值）
      return p.zones.graveyard
        .filter((c) => {
          const def = ctx.cards[c.defId];
          return def?.type === 'minion' && def.power <= bladeCount;
        })
        .map((c) => c.uid);
    case 'l5':
      // issue #105（Era 2026-10-21）：破坏**能给对手**，只给己方等于只能自杀。
      // 候选顺序：先己方后对手，力量值一律按卡面值 ≤ 炎刃数（与 1 档 / 号令同口径）。
      return [
        ...withinBlade(ownBoard),
        ...withinBlade(enemyBoard(state, me).map((c) => ({ uid: c.uid, defId: c.defId }))),
      ];
    case 'l3':
    case 'l7':
    case 'l9':
      // 增益类：己方任一随从（H22 未变）
      return ownBoard.map((c) => c.uid);
  }
}
