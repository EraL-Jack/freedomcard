/**
 * 卡牌效果系统测试 —— ADR-0023 / X-16（Era 2026-10-18 授权实现）。
 *
 * 与 rules.test.ts 的夹具不同：效果注册表按**真实 defId** 派发，
 * 故这里直接用生产卡池 `CARD_POOL`，不另编夹具卡。
 */

import { describe, expect, it } from 'vitest';

import {
  RULE_ERRORS,
  type CardInstance,
  type GameState,
  type Intent,
  type Phase,
  type RuleContext,
  type Zone,
} from '@app/shared';
import { CARD_POOL } from '@app/shared/cards';

import { applyIntent, createInitialState, reduce, INTENTS } from '../index.js';
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

  it('3 档：选择一个随从本回合力量值 +1（双方场上的随从都可选，H21）', () => {
    let s = base();
    s = run(s, intent('p1', INTENTS.effectActivate, { uid: 'lord1', effect: '1' }));
    s = run(s, intent('p1', INTENTS.effectChoose, { choice: 'l3' }));
    expect(s.pendingChoice?.kind).toBe('blade-lord-1-target');
    expect(s.pendingChoice?.options).toContain('fb1'); // 对方随从也是合法目标

    s = run(s, intent('p1', INTENTS.effectChoose, { choice: 'b1' }));
    expect(unitPower(s, CARD_POOL, 'b1')).toBe(2); // 1 + 1
    // 还有剩余次数 → 回到菜单
    expect(s.pendingChoice?.kind).toBe('blade-lord-1');
    s = run(s, intent('p1', INTENTS.effectChoose, { choice: 'pass' }));
    expect(s.pendingChoice).toBeNull();
  });

  it('1 档：从墓地召唤力量值 ≤ 炎刃数的随从', () => {
    let s = base();
    s = run(s, intent('p1', INTENTS.effectActivate, { uid: 'lord1', effect: '1' }));
    s = run(s, intent('p1', INTENTS.effectChoose, { choice: 'l1' }));
    // 支付【2】进墓地的 k1/k2 也是合法候选（bladeRecruit power 1 ≤ 3）
    expect(s.pendingChoice?.options).toEqual(['g1', 'k1', 'k2']);
    s = run(s, intent('p1', INTENTS.effectChoose, { choice: 'g1' }));
    expect(s.players['p1']!.zones.board.map((x) => x.uid)).toContain('g1');
    expect(s.players['p1']!.zones.graveyard.map((x) => x.uid)).not.toContain('g1');
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
