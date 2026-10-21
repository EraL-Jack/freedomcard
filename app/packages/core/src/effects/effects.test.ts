/**
 * 卡牌效果系统测试 —— ADR-0023 / X-16（Era 2026-10-18 授权实现）。
 *
 * 与 rules.test.ts 的夹具不同：效果注册表按**真实 defId** 派发，
 * 故这里直接用生产卡池 `CARD_POOL`，不另编夹具卡。
 */

import { describe, expect, it } from 'vitest';

import { RULE_ERRORS } from '@app/shared/constants';
import type { CardInstance, GameState, Intent, Phase, RuleContext, Zone } from '@app/shared/types';
import { CARD_POOL } from '@app/shared/cards';

import { applyIntent, createInitialState, reduce, replay, stateHash, INTENTS } from '../index.js';
import { EFFECTS_BY_KIND, summonEntryEvents, type EffectModule } from '../effects/index.js';
import { unitPower } from '../ops.js';

const CTX: RuleContext = { now: 1000, cards: CARD_POOL };

const c = (uid: string, defId: string): CardInstance => ({ uid, defId });

function intent(playerId: string, type: string, payload?: Record<string, unknown>): Intent {
  return { type, actor: 'player', playerId, seq: 1, payload };
}

function run(state: GameState, it: Intent): GameState {
  const r = applyIntent(state, it, CTX);
  if (!r.ok) throw new Error(`意外拒绝: ${r.error.code} ${r.error.message}`);
  let s = state;
  for (const e of r.value) s = reduce(s, e);
  return s;
}

/** 构造已开局状态 —— 与 rules.test.ts 的 craft 同构，但卡池用真卡。 */
function craft(patch: {
  phase?: Phase;
  turn?: number;
  activeSeat?: number;
  zones?: Partial<Record<Zone, CardInstance[]>>;
  foeZones?: Partial<Record<Zone, CardInstance[]>>;
}): GameState {
  const deck = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 'bladeRecruit' : 'bladeVanguard'));
  const s = createInitialState({
    seed: 1,
    seats: ['p1', 'p2'],
    decks: { p1: deck, p2: deck },
    commanders: { p1: 'bladeLord', p2: 'bladeLord' },
  });
  const out: GameState = {
    ...s,
    started: true,
    phase: patch.phase ?? 'main',
    turn: patch.turn ?? 2,
    activeSeat: patch.activeSeat ?? 0,
  };
  // docs/16 §3.3 的 maxCost 上限另有专门用例；夹具默认放宽，避免效果支付被额度挡住。
  // 指挥官档位取第 1 轮（1）—— 技能费用 = 3 − 档位 = 2，与本文件的历史断言一致。
  out.players = {
    ...out.players,
    p1: { ...out.players['p1']!, maxCost: 10, commanderPowerIndex: 1 },
    p2: { ...out.players['p2']!, maxCost: 10, commanderPowerIndex: 1 },
  };
  if (patch.zones) {
    const p = out.players['p1']!;
    out.players = { ...out.players, p1: { ...p, zones: { ...p.zones, ...patch.zones } } };
  }
  if (patch.foeZones) {
    const p = out.players['p2']!;
    out.players = { ...out.players, p2: { ...p, zones: { ...p.zones, ...patch.foeZones } } };
  }
  return out;
}

/** 统领在指挥官区的固定 uid。 */
const LORD = c('lord1', 'bladeLord');

describe('统领 Ⅱ：手牌除外', () => {
  it('发动后选择一张手牌除外；每回合只能一次', () => {
    let s = craft({
      zones: {
        commander: [LORD],
        hand: [c('h1', 'bladeVanguard'), c('h2', 'bladeScout')],
      },
    });
    s = run(s, intent('p1', INTENTS.effectActivate, { uid: 'lord1', effect: '2' }));
    expect(s.pendingChoice?.kind).toBe('blade-lord-2');
    expect(s.pendingChoice?.options).toEqual(['h1', 'h2']);

    // 挂起期间其他操作被拒（ADR-0023 §2 全局守卫）
    const blocked = applyIntent(s, intent('p1', INTENTS.phaseAdvance), CTX);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe(RULE_ERRORS.PENDING_CHOICE);

    s = run(s, intent('p1', INTENTS.effectChoose, { choice: 'h1' }));
    expect(s.pendingChoice).toBeNull();
    expect(s.players['p1']!.zones.exile.map((x) => x.uid)).toEqual(['h1']);
    expect(s.players['p1']!.zones.hand.map((x) => x.uid)).toEqual(['h2']);

    // 每回合一次
    const again = applyIntent(s, intent('p1', INTENTS.effectActivate, { uid: 'lord1', effect: '2' }), CTX);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe(RULE_ERRORS.EFFECT_UNAVAILABLE);
  });

  it('没有手牌时不可发动', () => {
    const s = craft({ zones: { commander: [LORD], hand: [] } });
    const r = applyIntent(s, intent('p1', INTENTS.effectActivate, { uid: 'lord1', effect: '2' }), CTX);
    expect(r.ok).toBe(false);
  });
});

describe('统领 Ⅰ：按除外区炎刃数分档', () => {
  const base = () =>
    craft({
      zones: {
        commander: [LORD],
        cost: [c('k1', 'bladeRecruit'), c('k2', 'bladeRecruit')],
        exile: [c('x1', 'bladeVanguard'), c('x2', 'bladeScout'), c('x3', 'bladeOrder')],
        graveyard: [c('g1', 'bladeVanguard')], // power 2 ≤ 3 → l1 可选
        board: [c('b1', 'bladeRecruit')],
      },
      foeZones: { board: [c('fb1', 'bladeKnight')] },
    });

  it('支付【2】= 费用区 2 张进弃牌区；菜单只列出已解锁档位', () => {
    let s = base();
    s = run(s, intent('p1', INTENTS.effectActivate, { uid: 'lord1', effect: '1' }));
    expect(s.players['p1']!.zones.cost.length).toBe(0);
    expect(s.players['p1']!.zones.graveyard.length).toBe(3); // 2 张支付 + 原有 1 张
    // 除外区 3 张炎刃 → 解锁 1 档与 3 档
    expect(s.pendingChoice?.kind).toBe('blade-lord-1');
    expect(s.pendingChoice?.options).toEqual(['l1', 'l3']);
  });

  it('3 档：选择一个随从本回合力量值 +1（限己方，H22 —— Era 2026-10-19 拍板）', () => {
    let s = base();
    s = run(s, intent('p1', INTENTS.effectActivate, { uid: 'lord1', effect: '1' }));
    s = run(s, intent('p1', INTENTS.effectChoose, { choice: 'l3' }));
    expect(s.pendingChoice?.kind).toBe('blade-lord-1-target');
    // H22：对方随从 fb1 不再是合法目标，候选只有己方 b1
    expect(s.pendingChoice?.options).toEqual(['b1']);

    s = run(s, intent('p1', INTENTS.effectChoose, { choice: 'b1' }));
    expect(unitPower(s, CARD_POOL, 'b1')).toBe(2); // 1 + 1
    // 还有剩余次数 → 回到菜单
    expect(s.pendingChoice?.kind).toBe('blade-lord-1');
    s = run(s, intent('p1', INTENTS.effectChoose, { choice: 'pass' }));
    expect(s.pendingChoice).toBeNull();
  });

  it('5 档：破坏力量值 ≤ 炎刃数的随从 —— 候选含对手场上（issue #105 / H22 修订）', () => {
    let s = craft({
      zones: {
        commander: [LORD],
        cost: [c('k1', 'bladeRecruit'), c('k2', 'bladeRecruit')],
        exile: Array.from({ length: 5 }, (_, i) => c(`x${i}`, 'bladeVanguard')), // 5 张炎刃
        board: [c('b1', 'bladeRecruit')],
      },
      // 对方随从力量 4 ≤ 5 → 可选；力量 6 的 bladeVeteran > 5 → 不可选
      foeZones: { board: [c('fb1', 'bladeKnight'), c('fb2', 'bladeVeteran')] },
    });
    s = run(s, intent('p1', INTENTS.effectActivate, { uid: 'lord1', effect: '1' }));
    s = run(s, intent('p1', INTENTS.effectChoose, { choice: 'l5' }));
    expect(s.pendingChoice?.kind).toBe('blade-lord-1-target');
    // 己方在前、对手在后；力量超标的对手随从 fb2 不出现
    expect(s.pendingChoice?.options).toEqual(['b1', 'fb1']);

    // 破坏对手随从 —— 结算路径必须按目标持有者搬卡，不能按发动者搬
    s = run(s, intent('p1', INTENTS.effectChoose, { choice: 'fb1' }));
    expect(s.players['p2']!.zones.board.map((x) => x.uid)).toEqual(['fb2']);
    expect(s.players['p2']!.zones.graveyard.map((x) => x.uid)).toEqual(['fb1']);
    // 自己的随从不受影响
    expect(s.players['p1']!.zones.board.map((x) => x.uid)).toEqual(['b1']);
  });

  it('5 档：也能破坏己方随从（候选是双方场上，不是只有对手）', () => {
    let s = craft({
      zones: {
        commander: [LORD],
        cost: [c('k1', 'bladeRecruit'), c('k2', 'bladeRecruit')],
        exile: Array.from({ length: 5 }, (_, i) => c(`x${i}`, 'bladeVanguard')),
        board: [c('b1', 'bladeRecruit')],
      },
      foeZones: { board: [c('fb1', 'bladeKnight')] },
    });
    s = run(s, intent('p1', INTENTS.effectActivate, { uid: 'lord1', effect: '1' }));
    s = run(s, intent('p1', INTENTS.effectChoose, { choice: 'l5' }));
    s = run(s, intent('p1', INTENTS.effectChoose, { choice: 'b1' }));
    expect(s.players['p1']!.zones.board).toHaveLength(0);
    expect(s.players['p1']!.zones.graveyard.map((x) => x.uid)).toContain('b1');
    expect(s.players['p2']!.zones.board.map((x) => x.uid)).toEqual(['fb1']);
  });

  it('9 档：授予「一回合一次，攻击后重置」，候选限己方（H22/H23）', () => {
    let s = craft({
      zones: {
        commander: [LORD],
        cost: [c('k1', 'bladeRecruit'), c('k2', 'bladeRecruit')],
        exile: Array.from({ length: 9 }, (_, i) => c(`x${i}`, 'bladeVanguard')), // 9 张炎刃
        board: [c('b1', 'bladeRecruit')],
      },
      foeZones: { board: [c('fb1', 'bladeKnight')] },
    });
    s = run(s, intent('p1', INTENTS.effectActivate, { uid: 'lord1', effect: '1' }));
    s = run(s, intent('p1', INTENTS.effectChoose, { choice: 'l9' }));
    expect(s.pendingChoice?.options).toEqual(['b1']); // 对方 fb1 不可选

    s = run(s, intent('p1', INTENTS.effectChoose, { choice: 'b1' }));
    expect(s.players['p1']!.zones.board[0]!.attackRefresh).toBe(true);
  });

  it('1 档：从弃牌区召唤力量值 ≤ 炎刃数的随从', () => {
    let s = base();
    s = run(s, intent('p1', INTENTS.effectActivate, { uid: 'lord1', effect: '1' }));
    s = run(s, intent('p1', INTENTS.effectChoose, { choice: 'l1' }));
    // 支付【2】进弃牌区的 k1/k2 也是合法候选（bladeRecruit power 1 ≤ 3）
    expect(s.pendingChoice?.options).toEqual(['g1', 'k1', 'k2']);
    s = run(s, intent('p1', INTENTS.effectChoose, { choice: 'g1' }));
    expect(s.players['p1']!.zones.board.map((x) => x.uid)).toContain('g1');
    expect(s.players['p1']!.zones.graveyard.map((x) => x.uid)).not.toContain('g1');
  });

  it('1 档召唤带登场选择的随从：选择排队，统领链结束后才触发（H28）', () => {
    // 夹具牌库全为炎刃卡 → 卫士登场磨到的一定是炎刃，必然弹「是否除外」。
    let s = craft({
      zones: {
        commander: [LORD],
        cost: [c('k1', 'bladeRecruit'), c('k2', 'bladeRecruit')],
        exile: [c('x1', 'bladeVanguard'), c('x2', 'bladeScout'), c('x3', 'bladeOrder')],
        graveyard: [c('g1', 'bladeGuard')],
        board: [c('b1', 'bladeRecruit')],
      },
    });
    s = run(s, intent('p1', INTENTS.effectActivate, { uid: 'lord1', effect: '1' }));
    s = run(s, intent('p1', INTENTS.effectChoose, { choice: 'l1' }));
    s = run(s, intent('p1', INTENTS.effectChoose, { choice: 'g1' }));

    // 关键：卫士的登场选择**没有**覆盖统领菜单，而是入队
    expect(s.pendingChoice?.kind).toBe('blade-lord-1');
    expect(s.pendingChoiceQueue).toHaveLength(1);
    expect(s.pendingChoiceQueue[0]!.kind).toBe('blade-guard-exile');
    expect(s.pendingChoiceQueue[0]!.sourceUid).toBe('g1');

    // 统领链结束 → 队列出队，挂起卫士的选择
    s = run(s, intent('p1', INTENTS.effectChoose, { choice: 'pass' }));
    expect(s.pendingChoice?.kind).toBe('blade-guard-exile');
    expect(s.pendingChoiceQueue).toHaveLength(0);

    // 回答卫士：不除外，收尾
    s = run(s, intent('p1', INTENTS.effectChoose, { choice: 'pass' }));
    expect(s.pendingChoice).toBeNull();
  });

  it('不在选择链中时，登场选择直接挂起而非入队（H28 边界）', () => {
    const s = craft({
      zones: { graveyard: [c('g1', 'bladeGuard')] },
    });
    // 直接派发登场效果：此时 pendingChoice 为 null → 应发 choice:pending
    const evs = summonEntryEvents(1000, s, 'p1', 'g1', CTX);
    expect(evs.some((e) => e.type === 'choice:pending')).toBe(true);
    expect(evs.some((e) => e.type === 'choice:queued')).toBe(false);
  });

  it('费用不足 2 张时不可发动', () => {
    const s = craft({
      zones: { commander: [LORD], cost: [c('k1', 'bladeRecruit')], exile: [c('x1', 'bladeVanguard')] },
    });
    const r = applyIntent(s, intent('p1', INTENTS.effectActivate, { uid: 'lord1', effect: '1' }), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.ok === false && r.error.code).toBe(RULE_ERRORS.INSUFFICIENT_COST);
  });

  it('除外区无炎刃时档位不足', () => {
    const s = craft({
      zones: { commander: [LORD], cost: [c('k1', 'bladeRecruit'), c('k2', 'bladeRecruit')], exile: [] },
    });
    const r = applyIntent(s, intent('p1', INTENTS.effectActivate, { uid: 'lord1', effect: '1' }), CTX);
    expect(r.ok).toBe(false);
  });

  it('回合切换清空临时修正（「本回合」词缀，ADR-0023 §3）', () => {
    let s = base();
    s = run(s, intent('p1', INTENTS.effectActivate, { uid: 'lord1', effect: '1' }));
    s = run(s, intent('p1', INTENTS.effectChoose, { choice: 'l3' }));
    s = run(s, intent('p1', INTENTS.effectChoose, { choice: 'b1' }));
    s = run(s, intent('p1', INTENTS.effectChoose, { choice: 'pass' }));
    expect(unitPower(s, CARD_POOL, 'b1')).toBe(2);

    // 模拟回合切换事件（turn:changed 负责清临时态）
    s = reduce(s, { type: 'turn:changed', at: 1001, payload: { turn: 3, activeSeat: 1 } });
    expect(unitPower(s, CARD_POOL, 'b1')).toBe(1); // tempPower 已清
  });
});

describe('统领 9 档：「一回合一次，攻击后重置」（H23 —— Era 2026-10-19 拍板）', () => {
  const battle = () =>
    craft({
      phase: 'battle',
      zones: {
        commander: [LORD],
        board: [{ uid: 'a1', defId: 'bladeVanguard', attackRefresh: true }],
      },
      foeZones: { board: [c('fb1', 'bladeRecruit'), c('fb2', 'bladeRecruit'), c('fb3', 'bladeRecruit')] },
    });

  it('置位时第一次攻击不休眠，生效一次即消耗；第二次攻击后照常休眠', () => {
    let s = battle();
    // 第一次攻击：2 > 1，防守方破坏；攻击方不休眠，attackRefresh 被消耗
    s = run(s, intent('p1', INTENTS.attack, { attackerUid: 'a1', targetUid: 'fb1' }));
    const a1 = s.players['p1']!.zones.board[0]!;
    expect(a1.sleeping).toBeFalsy();
    expect(a1.attackRefresh).toBeUndefined();

    // 第二次攻击：允许（未休眠），之后照常休眠
    s = run(s, intent('p1', INTENTS.attack, { attackerUid: 'a1', targetUid: 'fb2' }));
    expect(s.players['p1']!.zones.board[0]!.sleeping).toBe(true);

    // 第三次攻击：已休眠，被拒
    const third = applyIntent(s, intent('p1', INTENTS.attack, { attackerUid: 'a1', targetUid: 'fb3' }), CTX);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.error.code).toBe(RULE_ERRORS.UNIT_ASLEEP);
  });
});

describe('军师：登场触发器', () => {
  it('发动后己方炎刃随从登场 +1，次数受除外区炎刃数限制', () => {
    let s = craft({
      phase: 'main',
      zones: {
        commander: [LORD],
        board: [c('tac1', 'bladeTactician')],
        hand: [c('h1', 'bladeVanguard'), c('h2', 'bladeVanguard')],
        cost: [c('k1', 'bladeRecruit'), c('k2', 'bladeRecruit')],
        exile: [c('x1', 'bladeScout')], // 1 张炎刃 → 触发 1 次
      },
    });
    s = run(s, intent('p1', INTENTS.effectActivate, { uid: 'tac1', effect: '1' }));
    expect(s.players['p1']!.turnTriggers).toHaveLength(1);

    // 出一张炎刃随从 → +1
    s = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    expect(unitPower(s, CARD_POOL, 'h1')).toBe(3); // 2 + 1
    expect(s.players['p1']!.turnTriggers).toHaveLength(0); // 次数耗尽即移除

    // 第二张不再触发
    s = run(s, intent('p1', INTENTS.play, { uid: 'h2' }));
    expect(unitPower(s, CARD_POOL, 'h2')).toBe(2);
  });
});

describe('号令：展示 7 张选随从召唤', () => {
  it('展示 → 选择力量值 ≤ 炎刃数的随从召唤，其余洗回卡组', () => {
    const s = craft({
      phase: 'main',
      zones: {
        commander: [LORD],
        hand: [c('ord1', 'bladeOrder')],
        cost: [c('k1', 'bladeRecruit')],
        exile: [c('x1', 'bladeVanguard'), c('x2', 'bladeScout')], // 2 张炎刃
        deck: [
          c('d1', 'bladeVanguard'), // power 2 ≤ 2 → 可选
          c('d2', 'bladeKnight'), // power 4 > 2 → 不可选
          c('d3', 'bladeRecruit'), // power 1 ≤ 2 → 可选
          c('d4', 'bladeRecruit'),
          c('d5', 'bladeRecruit'),
          c('d6', 'bladeRecruit'),
          c('d7', 'bladeRecruit'),
          c('d8', 'bladeRecruit'),
        ],
      },
    });
    let next = run(s, intent('p1', INTENTS.play, { uid: 'ord1' }));
    expect(next.pendingChoice?.kind).toBe('blade-order-summon');
    // d2（bladeKnight power 4 > 2）被排除，其余力量值 ≤ 2 的随从均可选
    expect(next.pendingChoice?.options).toEqual(['d1', 'd3', 'd4', 'd5', 'd6', 'd7']);

    const deckBefore = next.players['p1']!.zones.deck.length;
    next = run(next, intent('p1', INTENTS.effectChoose, { choice: 'd1' }));
    expect(next.pendingChoice).toBeNull();
    expect(next.players['p1']!.zones.board.map((x) => x.uid)).toContain('d1');
    // 其余展示卡洗回卡组：总数只少被召唤的 1 张
    expect(next.players['p1']!.zones.deck.length).toBe(deckBefore - 1);
  });

  it('展示中有斥候时先问是否除外（斥候卡面触发）', () => {
    const s = craft({
      phase: 'main',
      zones: {
        commander: [LORD],
        hand: [c('ord1', 'bladeOrder')],
        cost: [c('k1', 'bladeRecruit')],
        exile: [c('x1', 'bladeVanguard'), c('x2', 'bladeScout')],
        deck: [
          c('d1', 'bladeScout'), // 斥候被展示 → 触发可选除外
          c('d2', 'bladeVanguard'),
          c('d3', 'bladeRecruit'),
          c('d4', 'bladeRecruit'),
          c('d5', 'bladeRecruit'),
          c('d6', 'bladeRecruit'),
          c('d7', 'bladeRecruit'),
        ],
      },
    });
    let next = run(s, intent('p1', INTENTS.play, { uid: 'ord1' }));
    expect(next.pendingChoice?.kind).toBe('blade-scout-exile');
    expect(next.pendingChoice?.options).toEqual(['d1']);

    next = run(next, intent('p1', INTENTS.effectChoose, { choice: 'd1' }));
    expect(next.players['p1']!.zones.exile.map((x) => x.uid)).toContain('d1');
    // 然后进入召唤选择（斥候已除外，不在揭示列表里）
    expect(next.pendingChoice?.kind).toBe('blade-order-summon');
    expect(next.pendingChoice?.options).toContain('d2');
  });
});

/**
 * 回放：选择链排队（H28 / D-145）。
 *
 * 排队字段（pendingChoiceQueue）是新增的状态字段 —— 它必须能由**事件流**完整重建，
 * 否则「种子 + Intent 序列」的重放会在出队那一步与实机分叉。
 * 这里把含排队的那一段完整跑两遍，比对哈希链与终态。
 */
describe('回放：H28 排队序列', () => {
  it('同一 Intent 序列重跑两次：哈希链、终态、队列清空都一致', () => {
    const base = craft({
      zones: {
        commander: [c('lord1', 'bladeLord')],
        cost: [c('k1', 'bladeRecruit'), c('k2', 'bladeRecruit')],
        exile: [c('x1', 'bladeVanguard'), c('x2', 'bladeScout'), c('x3', 'bladeOrder')],
        graveyard: [c('g1', 'bladeGuard')],
        board: [c('b1', 'bladeRecruit')],
      },
    });
    const intents: Intent[] = [
      intent('p1', INTENTS.effectActivate, { uid: 'lord1', effect: '1' }),
      intent('p1', INTENTS.effectChoose, { choice: 'l1' }),
      intent('p1', INTENTS.effectChoose, { choice: 'g1' }), // 卫士登场 → 选择入队
      intent('p1', INTENTS.effectChoose, { choice: 'pass' }), // 统领链结束 → 出队
      intent('p1', INTENTS.effectChoose, { choice: 'pass' }), // 卫士放弃
    ];
    const deps = { applyIntent, reduce, stateHash, cards: CARD_POOL, now: (step: number) => 1000 + step * 10 };

    const a = replay(base, intents, deps);
    const b = replay(base, intents, deps);

    expect(a.failedAt).toBeNull();
    expect(a.hashChain).toEqual(b.hashChain);
    expect(a.state).toEqual(b.state);
    // 链条走完：没有悬挂选择，队列也已清空
    expect(a.state.pendingChoice).toBeNull();
    expect(a.state.pendingChoiceQueue).toEqual([]);
  });
});

/**
 * 选择链收尾的**结构兜底**（D-260 / issue #88）。
 *
 * 每个效果模块的 `choose` 都要自己发 `choice:cleared`，漏一次就是「面板关不掉、
 * 对局卡死」（炎刃骑士就是这么坏的）。这条兜底放在 `effectChooseRule`，
 * 这里用一个**故意漏写**的假模块证明它真的生效 —— 否则将来又有人漏写时，
 * 单测全绿、线上死锁。
 */
describe('选择链收尾兜底（D-260）', () => {
  const KIND = '__test-no-clear';

  function stateWithPending(kind: string, options: string[]): GameState {
    const s = craft({ zones: { graveyard: [c('g1', 'bladeVanguard')] } });
    return {
      ...s,
      pendingChoice: { playerId: 'p1', kind, sourceUid: 'g1', options },
    };
  }

  it('模块漏写 choice:cleared 时，规则层补一条 —— 选择不会永远挂着', () => {
    const registry = EFFECTS_BY_KIND as Record<string, EffectModule>;
    registry[KIND] = { choose: () => ({ ok: true, value: [] }) };
    try {
      const s = stateWithPending(KIND, ['g1']);
      const r = applyIntent(s, intent('p1', INTENTS.effectChoose, { choice: 'g1' }), CTX);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.filter((e) => e.type === 'choice:cleared')).toHaveLength(1);
      // 落地后不再有悬挂选择
      const after = r.value.reduce((acc, e) => reduce(acc, e), s);
      expect(after.pendingChoice).toBeNull();
    } finally {
      delete registry[KIND];
    }
  });

  it('模块自己收尾时不重复补 —— 事件流保持干净', () => {
    const registry = EFFECTS_BY_KIND as Record<string, EffectModule>;
    registry[KIND] = {
      choose: (state, it_, ctx) => ({
        ok: true,
        value: [{ type: 'choice:cleared', at: ctx.now, payload: {} } as never],
      }),
    };
    try {
      const s = stateWithPending(KIND, ['g1']);
      const r = applyIntent(s, intent('p1', INTENTS.effectChoose, { choice: 'g1' }), CTX);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.filter((e) => e.type === 'choice:cleared')).toHaveLength(1);
    } finally {
      delete registry[KIND];
    }
  });
});
