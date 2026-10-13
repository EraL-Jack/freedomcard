import { describe, expect, it } from 'vitest';

import {
  BOARD_SLOTS,
  DECK_SIZE,
  INITIAL_HAND,
  MAIN_DECK_SIZE,
  RULE_ERRORS,
  type CardDef,
  type CardInstance,
  type GameState,
  type Intent,
  type Phase,
  type RuleContext,
  type Zone,
} from '@app/shared';

import { applyIntent, createInitialState, reduce, stateHash, INTENTS } from '../index.js';

/* ------------------------------ 夹具 ------------------------------ */

/**
 * 卡池夹具 —— 仅供测试。
 *
 * ⚠️ 这是**测试夹具**，不是卡池数据。生产卡池（`server/src/cards.ts`）仍是空的，
 * 等 Era 给；这里编卡只是为了能跑通规则，不进入任何交付件。
 */
const CARDS: Record<string, CardDef> = {
  cmd: { defId: 'cmd', name: '指挥官', type: 'commander', cost: 0, power: 5 },
  m1: { defId: 'm1', name: '随从1', type: 'minion', cost: 1, power: 2 },
  m2: { defId: 'm2', name: '随从2', type: 'minion', cost: 2, power: 3 },
  s1: { defId: 's1', name: '法术1', type: 'spell', cost: 1, power: 0 },
  c1: { defId: 'c1', name: '持续1', type: 'continuous', cost: 1, power: 0 },
};
for (let i = 3; i <= 10; i++) {
  CARDS[`m${i}`] = { defId: `m${i}`, name: `随从${i}`, type: 'minion', cost: 0, power: i };
}

/** 主卡组 30 张：m1×3（cost1）、m2×3（cost2）、m3..m10 各 3 张（cost0）。 */
const DECK: string[] = [];
for (const id of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10']) {
  for (let k = 0; k < 3; k++) DECK.push(id);
}

const CTX: RuleContext = { now: 1000, cards: CARDS };

const c = (uid: string, defId: string): CardInstance => ({ uid, defId });

function intent(playerId: string, type: string, payload?: Record<string, unknown>): Intent {
  return { type, actor: 'player', playerId, seq: 1, payload };
}

/** 执行一条 Intent 并演进状态；失败时抛出，便于断言链。 */
function run(state: GameState, it_: Intent, ctx: RuleContext = CTX): GameState {
  const r = applyIntent(state, it_, ctx);
  if (!r.ok) throw new Error(`意外拒绝: ${r.error.code} ${r.error.message}`);
  let s = state;
  for (const e of r.value) s = reduce(s, e);
  return s;
}

/** 执行一条 Intent，返回「事件列表 + 演进后状态」，供需要检查事件的用例使用。 */
function runWith(state: GameState, it_: Intent, ctx: RuleContext = CTX) {
  const r = applyIntent(state, it_, ctx);
  if (!r.ok) throw new Error(`意外拒绝: ${r.error.code} ${r.error.message}`);
  let s = state;
  for (const e of r.value) s = reduce(s, e);
  return { events: r.value, state: s };
}

/** 直接构造一个「已开局」的状态，手牌与费用区由调用方指定 —— 避免测试依赖洗牌结果。 */
function craft(patch: {
  phase?: Phase;
  turn?: number;
  activeSeat?: number;
  zones?: Partial<Record<Zone, CardInstance[]>>;
}): GameState {
  const s = createInitialState({
    seed: 1,
    seats: ['p1', 'p2'],
    decks: { p1: DECK, p2: DECK },
    commanders: { p1: 'cmd', p2: 'cmd' },
  });
  const out: GameState = {
    ...s,
    started: true,
    phase: patch.phase ?? 'main',
    turn: patch.turn ?? 1,
    activeSeat: patch.activeSeat ?? 0,
  };
  if (patch.zones) {
    const p = out.players['p1']!;
    out.players = { ...out.players, p1: { ...p, zones: { ...p.zones, ...patch.zones } } };
  }
  return out;
}

function fresh(): GameState {
  return createInitialState({
    seed: 42,
    seats: ['p1', 'p2'],
    decks: { p1: DECK, p2: DECK },
    commanders: { p1: 'cmd', p2: 'cmd' },
  });
}

/* ------------------------------ 卡组校验 ------------------------------ */

describe('卡组构成（ADR-0012 补充：31 = 30 + 1）', () => {
  it('主卡组 30 张 + 指挥官 1 张 构成 31 张', () => {
    expect(MAIN_DECK_SIZE).toBe(30);
    expect(DECK_SIZE).toBe(31);
    expect(DECK.length).toBe(MAIN_DECK_SIZE);
  });

  it('主卡组 29 张 → 拒绝 INVALID_DECK', () => {
    const s = createInitialState({
      seed: 1,
      seats: ['p1', 'p2'],
      decks: { p1: DECK.slice(0, 29), p2: DECK },
      commanders: { p1: 'cmd', p2: 'cmd' },
    });
    const r = applyIntent(s, intent('p1', INTENTS.start), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.INVALID_DECK);
  });

  it('总数对但缺指挥官 → 同样拒绝（只校验总数会漏掉这种情况）', () => {
    const s = createInitialState({
      seed: 1,
      seats: ['p1', 'p2'],
      decks: { p1: DECK, p2: DECK },
      commanders: { p1: '', p2: '' },
    });
    const r = applyIntent(s, intent('p1', INTENTS.start), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.INVALID_DECK);
  });

  it('同名超过 3 张 → 拒绝', () => {
    const bad = ['m1', 'm1', 'm1', 'm1', ...DECK.slice(0, 26)];
    const s = createInitialState({
      seed: 1,
      seats: ['p1', 'p2'],
      decks: { p1: bad, p2: DECK },
      commanders: { p1: 'cmd', p2: 'cmd' },
    });
    const r = applyIntent(s, intent('p1', INTENTS.start), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('同名卡');
  });
});

/* ------------------------------ 开局 ------------------------------ */

describe('开局 startRule', () => {
  it('洗牌 → 掷骰 → 揭示指挥官 → 各发起手 5 张', () => {
    const s = run(fresh(), intent('p1', INTENTS.start));
    expect(s.started).toBe(true);
    for (const id of ['p1', 'p2']) {
      const p = s.players[id]!;
      expect(p.zones.hand.length).toBe(INITIAL_HAND);
      expect(p.zones.deck.length).toBe(MAIN_DECK_SIZE - INITIAL_HAND);
      expect(p.zones.commander.length).toBe(1);
      expect(p.commanderRevealed).toBe(true);
      expect(p.zones.commander[0]!.defId).toBe('cmd');
    }
  });

  it('指挥官不进主卡组：牌库里没有 commander 类型的卡', () => {
    const s = run(fresh(), intent('p1', INTENTS.start));
    for (const id of ['p1', 'p2']) {
      const all = [...s.players[id]!.zones.deck, ...s.players[id]!.zones.hand];
      expect(all.every((card) => CARDS[card.defId]!.type !== 'commander')).toBe(true);
    }
  });

  it('先后手由 1d6 决定，seats[0] 是点数较大者，且点数不同', () => {
    const { events, state: started } = runWith(fresh(), intent('p1', INTENTS.start));
    const evt = events.find((e) => e.type === 'game:started');
    expect(evt).toBeDefined();
    const rolls = evt!.payload!.rolls as Record<string, number>;
    const a = rolls['p1']!;
    const b = rolls['p2']!;
    expect(a).toBeGreaterThanOrEqual(1);
    expect(a).toBeLessThanOrEqual(6);
    expect(a).not.toBe(b);
    expect(started.seats[0]).toBe(a > b ? 'p1' : 'p2');
  });

  it('重复开局 → 拒绝 ALREADY_STARTED', () => {
    const s = run(fresh(), intent('p1', INTENTS.start));
    const r = applyIntent(s, intent('p1', INTENTS.start), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.ALREADY_STARTED);
  });

  it('同一 seed 两次开局结果完全一致（可复现）', () => {
    const h1 = stateHash(run(fresh(), intent('p1', INTENTS.start)));
    const h2 = stateHash(run(fresh(), intent('p1', INTENTS.start)));
    expect(h1).toBe(h2);
  });

  it('不同 seed 开局结果不同（否则说明随机没接上）', () => {
    const a = run(fresh(), intent('p1', INTENTS.start));
    const b = run(
      createInitialState({
        seed: 999,
        seats: ['p1', 'p2'],
        decks: { p1: DECK, p2: DECK },
        commanders: { p1: 'cmd', p2: 'cmd' },
      }),
      intent('p1', INTENTS.start),
    );
    expect(stateHash(a)).not.toBe(stateHash(b));
  });
});

/* ------------------------------ 起手换牌 ------------------------------ */

describe('起手换牌 mulliganRule', () => {
  const started = (): GameState => run(fresh(), intent('p1', INTENTS.start));

  it('返回 2 张后手牌仍是 5 张、牌库仍是 25 张', () => {
    const s = started();
    const active = s.seats[0]!;
    const returning = s.players[active]!.zones.hand.slice(0, 2).map((x) => x.uid);
    const after = run(s, intent(active, INTENTS.mulligan, { returns: returning }));
    const p = after.players[active]!;
    expect(p.zones.hand.length).toBe(INITIAL_HAND);
    expect(p.zones.deck.length).toBe(MAIN_DECK_SIZE - INITIAL_HAND);
    expect(p.mulliganDone).toBe(true);
  });

  it('换 0 张也可以（任意数量，含 0）', () => {
    const s = started();
    const active = s.seats[0]!;
    const after = run(s, intent(active, INTENTS.mulligan, { returns: [] }));
    expect(after.players[active]!.mulliganDone).toBe(true);
    expect(after.players[active]!.zones.hand.length).toBe(INITIAL_HAND);
  });

  it('第二次换牌 → 拒绝 MULLIGAN_DONE', () => {
    const s = started();
    const active = s.seats[0]!;
    const after = run(s, intent(active, INTENTS.mulligan, { returns: [] }));
    const r = applyIntent(after, intent(active, INTENTS.mulligan, { returns: [] }), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.MULLIGAN_DONE);
  });

  it('不在第一回合充能阶段 → 拒绝 WRONG_PHASE', () => {
    const s = craft({ phase: 'main', turn: 1 });
    const r = applyIntent(s, intent('p1', INTENTS.mulligan, { returns: [] }), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.WRONG_PHASE);
  });

  it('返回不在手牌里的 uid → 拒绝 CARD_NOT_IN_ZONE', () => {
    const s = started();
    const active = s.seats[0]!;
    const r = applyIntent(s, intent(active, INTENTS.mulligan, { returns: ['p1#0'] }), CTX);
    // p1#0 可能已在手牌中（洗牌后不确定），故只在确实不在时断言
    if (!s.players[active]!.zones.hand.some((x) => x.uid === 'p1#0')) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.CARD_NOT_IN_ZONE);
    }
  });
});

/* ------------------------------ 阶段流转 ------------------------------ */

describe('阶段流转 phaseRule', () => {
  it('六阶段顺序固定，逐档推进不跳步', () => {
    let s = craft({ phase: 'charge', turn: 2 });
    const seen: Phase[] = [s.phase];
    for (let i = 0; i < 5; i++) {
      s = run(s, intent('p1', INTENTS.phaseAdvance));
      seen.push(s.phase);
    }
    expect(seen).toEqual(['charge', 'reset', 'draw', 'main', 'battle', 'end']);
  });

  it('进入重置阶段清除己方随从休眠', () => {
    const s = craft({
      phase: 'charge',
      turn: 2,
      zones: { board: [c('p1#0', 'm1'), { uid: 'p1#1', defId: 'm1', sleeping: true }] },
    });
    const after = run(s, intent('p1', INTENTS.phaseAdvance));
    expect(after.players['p1']!.zones.board.every((x) => x.sleeping !== true)).toBe(true);
  });

  it('抽排阶段抽 2 张；第一回合先攻方只抽 1 张（A10-3）', () => {
    const t2 = run(run(craft({ phase: 'charge', turn: 2 }), intent('p1', INTENTS.phaseAdvance)), intent('p1', INTENTS.phaseAdvance));
    expect(t2.players['p1']!.zones.hand.length).toBe(2);

    const t1 = run(run(craft({ phase: 'charge', turn: 1 }), intent('p1', INTENTS.phaseAdvance)), intent('p1', INTENTS.phaseAdvance));
    expect(t1.players['p1']!.zones.hand.length).toBe(1);
  });

  it('结束阶段之后进入下一回合：换行动方、回合 +1、最高费用按曲线增长', () => {
    let s = craft({ phase: 'charge', turn: 1, activeSeat: 0 });
    for (let i = 0; i < 6; i++) s = run(s, intent(s.seats[s.activeSeat]!, INTENTS.phaseAdvance));
    expect(s.turn).toBe(2);
    expect(s.activeSeat).toBe(1);
    expect(s.phase).toBe('charge');
    expect(s.players['p2']!.maxCost).toBe(3);
  });

  it('非行动方推进阶段 → 拒绝 NOT_YOUR_TURN', () => {
    const s = craft({ phase: 'charge' });
    const r = applyIntent(s, intent('p2', INTENTS.phaseAdvance), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.NOT_YOUR_TURN);
  });
});

/* ------------------------------ 充能 ------------------------------ */

describe('充能 chargeRule（X-2，充能区即费用区）', () => {
  it('把手牌里的随从置入费用区', () => {
    const s = craft({ phase: 'charge', zones: { hand: [c('h1', 'm1')] } });
    const after = run(s, intent('p1', INTENTS.charge, { uids: ['h1'] }));
    expect(after.players['p1']!.zones.cost.length).toBe(1);
    expect(after.players['p1']!.zones.cost[0]!.uid).toBe('h1');
    expect(after.players['p1']!.zones.hand.length).toBe(0);
  });

  it('场上随从也可以充能（任意数量）', () => {
    const s = craft({ phase: 'charge', zones: { board: [c('b1', 'm1'), c('b2', 'm1')] } });
    const after = run(s, intent('p1', INTENTS.charge, { uids: ['b1', 'b2'] }));
    expect(after.players['p1']!.zones.cost.length).toBe(2);
    expect(after.players['p1']!.zones.board.length).toBe(0);
  });

  it('非充能阶段 → 拒绝 WRONG_PHASE', () => {
    const s = craft({ phase: 'main', zones: { hand: [c('h1', 'm1')] } });
    const r = applyIntent(s, intent('p1', INTENTS.charge, { uids: ['h1'] }), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.WRONG_PHASE);
  });

  it('充能非随从（指挥官）→ 拒绝', () => {
    const s = craft({ phase: 'charge', zones: { hand: [c('h1', 'cmd')] } });
    const r = applyIntent(s, intent('p1', INTENTS.charge, { uids: ['h1'] }), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.CARD_NOT_IN_ZONE);
  });

  it('不能充能对手的卡', () => {
    const s = craft({ phase: 'charge' });
    const r = applyIntent(s, intent('p1', INTENTS.charge, { uids: ['p2#0'] }), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.CARD_NOT_IN_ZONE);
  });
});

/* ------------------------------ 出牌与支付 ------------------------------ */

describe('出牌 playRule（A5 补充 2：按张数支付）', () => {
  it('支付 = 从费用区取 cost 张送入弃牌区', () => {
    const s = craft({
      phase: 'main',
      zones: { hand: [c('h1', 'm1')], cost: [c('k1', 'm4'), c('k2', 'm4')] },
    });
    const after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    const p = after.players['p1']!;
    expect(p.zones.board.map((x) => x.uid)).toContain('h1');
    expect(p.zones.cost.length).toBe(1); // 2 - cost(1)
    expect(p.zones.graveyard.length).toBe(1);
    expect(p.zones.graveyard[0]!.uid).toBe('k1'); // 按费用区顺序从前往后取
  });

  it('费用区张数不足 → 拒绝 INSUFFICIENT_COST', () => {
    const s = craft({ phase: 'main', zones: { hand: [c('h1', 'm1')], cost: [] } });
    const r = applyIntent(s, intent('p1', INTENTS.play, { uid: 'h1' }), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.INSUFFICIENT_COST);
  });

  it('cost 为 0 的卡无需支付即可打出', () => {
    const s = craft({ phase: 'main', zones: { hand: [c('h1', 'm3')], cost: [] } });
    const after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    expect(after.players['p1']!.zones.board.length).toBe(1);
    expect(after.players['p1']!.zones.graveyard.length).toBe(0);
  });

  it('随从区满（3）→ 拒绝 BOARD_FULL', () => {
    const s = craft({
      phase: 'main',
      zones: {
        hand: [c('h1', 'm3')],
        board: [c('b1', 'm3'), c('b2', 'm3'), c('b3', 'm3')],
      },
    });
    expect(s.players['p1']!.zones.board.length).toBe(BOARD_SLOTS);
    const r = applyIntent(s, intent('p1', INTENTS.play, { uid: 'h1' }), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.BOARD_FULL);
  });

  it('法术进入法术区而非随从区（效果结算本身仍是 TODO）', () => {
    const s = craft({
      phase: 'main',
      zones: { hand: [c('h1', 's1')], cost: [c('k1', 'm4')] },
    });
    const after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    expect(after.players['p1']!.zones.spell.length).toBe(1);
    expect(after.players['p1']!.zones.board.length).toBe(0);
  });

  it('非主要阶段出牌 → 拒绝 WRONG_PHASE', () => {
    const s = craft({ phase: 'battle', zones: { hand: [c('h1', 'm3')] } });
    const r = applyIntent(s, intent('p1', INTENTS.play, { uid: 'h1' }), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.WRONG_PHASE);
  });

  it('指挥官不能从手牌打出（X-1：揭示入区）', () => {
    const s = craft({ phase: 'main', zones: { hand: [c('h1', 'cmd')] } });
    const r = applyIntent(s, intent('p1', INTENTS.play, { uid: 'h1' }), CTX);
    expect(r.ok).toBe(false);
  });
});

/* ------------------------------ 结束回合 / 认输 ------------------------------ */

describe('结束回合 turnEndRule', () => {
  it('从主要阶段一路推进到下一回合，不跳阶段', () => {
    const s = craft({ phase: 'main', turn: 1 });
    const r = applyIntent(s, intent('p1', INTENTS.turnEnd), CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    let after = s;
    const phases: string[] = [];
    for (const e of r.value) {
      if (e.type === 'phase:changed') phases.push(String(e.payload!.to));
      after = reduce(after, e);
    }
    expect(phases).toEqual(['battle', 'end', 'charge']);
    expect(after.turn).toBe(2);
    expect(after.activeSeat).toBe(1);
  });

  it('系统 Intent（超时）与玩家走同一条链路', () => {
    const s = craft({ phase: 'main', turn: 1 });
    const sys: Intent = { type: INTENTS.turnEnd, actor: 'system', playerId: 'p1', seq: 1, reason: 'timeout' };
    const r = applyIntent(s, sys, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    let after = s;
    for (const e of r.value) after = reduce(after, e);
    expect(after.turn).toBe(2);
  });
});

describe('认输 concedeRule', () => {
  it('认输后对手获胜', () => {
    const s = craft({ phase: 'main' });
    const after = run(s, intent('p1', INTENTS.concede));
    expect(after.winner).toBe('p2');
  });

  it('对局已结束后再认输 → 拒绝 GAME_OVER', () => {
    const s = run(craft({ phase: 'main' }), intent('p1', INTENTS.concede));
    const r = applyIntent(s, intent('p1', INTENTS.concede), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.GAME_OVER);
  });
});

/* ------------------------------ 攻击（占位） ------------------------------ */

describe('攻击 attackRule（占位，等 Era 补字段）', () => {
  it('明确返回 NOT_IMPLEMENTED，而不是静默通过', () => {
    const s = craft({ phase: 'battle', zones: { board: [c('p1#0', 'm1')] } });
    const r = applyIntent(s, intent('p1', INTENTS.attack, { attackerUid: 'p1#0' }), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.NOT_IMPLEMENTED);
  });
});

/* ------------------------------ 确定性 ------------------------------ */

describe('确定性', () => {
  it('同一串 Intent 跑两遍，状态哈希一致', () => {
    const seq = (base: GameState): GameState => {
      let s = run(base, intent('p1', INTENTS.start), { now: 1, cards: CARDS });
      const active = s.seats[0]!;
      s = run(s, intent(active, INTENTS.mulligan, { returns: [] }), { now: 2, cards: CARDS });
      for (let i = 0; i < 6; i++) {
        s = run(s, intent(s.seats[s.activeSeat]!, INTENTS.phaseAdvance), { now: 3 + i, cards: CARDS });
      }
      return s;
    };
    expect(stateHash(seq(fresh()))).toBe(stateHash(seq(fresh())));
  });
});
