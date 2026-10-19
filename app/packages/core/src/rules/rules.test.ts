import { describe, expect, it } from 'vitest';

import {
  BOARD_SLOTS,
  COST_INCOME_PER_TURN,
  DECK_SIZE,
  INITIAL_HAND,
  INITIAL_HEALTH,
  KEYWORD_TAUNT,
  MAIN_DECK_SIZE,
  MULLIGAN_WINDOW_MS,
  RULE_ERRORS,
  SECOND_PLAYER_HAND,
  type CardDef,
  type CardInstance,
  type GameEvent,
  type GameState,
  type Intent,
  type Phase,
  type RuleContext,
  type Zone,
} from '@app/shared';

import { applyIntent, createInitialState, reduce, stateHash, INTENTS } from '../index.js';

import { unitPower } from '../ops.js';
import { resolveCombat } from './attack.js';

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
  /** 力量 7 / 伤害 3 —— 用于验证「伤害值与力量值不是一回事」（ADR-0014 H13）。 */
  d7: { defId: 'd7', name: '重击随从', type: 'minion', cost: 3, power: 7, damage: 3 },
  /** 力量 6 / 伤害 5 —— 验证伤害值可以**大于**力量值，两者互不推导（X-5）。 */
  d6: { defId: 'd6', name: '爆发随从', type: 'minion', cost: 3, power: 6, damage: 5 },
  s1: { defId: 's1', name: '法术1', type: 'spell', cost: 1, power: 0 },
  c1: { defId: 'c1', name: '持续1', type: 'continuous', cost: 1, power: 0 },
  /** 嘲讽随从 —— A7 现仅此一个关键词，故夹具里也只有一个。 */
  ta1: { defId: 'ta1', name: '嘲讽随从', type: 'minion', cost: 1, power: 4, keywords: [KEYWORD_TAUNT] },
  /**
   * 带力量值曲线的指挥官 —— X-7 / ADR-0016。
   *
   * `power` 记的是**初始档位的值**（与曲线首项一致，0）；
   * 不带曲线的 `cmd`（power 5）则恒取定值，不成长 —— 两种形态都要能跑通。
   */
  cmdCurve: {
    defId: 'cmdCurve',
    name: '曲线指挥官',
    type: 'commander',
    cost: 0,
    power: 0,
    powerCurve: [0, 1, 3, 5],
  },
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
  /** 己方（p1）区域。 */
  zones?: Partial<Record<Zone, CardInstance[]>>;
  /** 对手（p2）区域 —— 攻击测试需要给对方摆随从 / 指挥官。 */
  foeZones?: Partial<Record<Zone, CardInstance[]>>;
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
  // 夹具默认放宽 maxCost（docs/16 §3.3 的上限另有专门用例），
  // 否则几乎每个出牌用例都会被「第 1 回合只能花 1 张」挡住。
  out.players = {
    ...out.players,
    p1: { ...out.players['p1']!, maxCost: 10 },
    p2: { ...out.players['p2']!, maxCost: 10 },
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
  it('洗牌 → 掷骰 → 揭示指挥官 → 发起手（先手 5 / 后手 6）；先攻首回合 0 充能（D-227）', () => {
    const s = run(fresh(), intent('p1', INTENTS.start));
    expect(s.started).toBe(true);
    const [first, second] = s.seats as [string, string];
    // docs/16 §1：先手 5、后手 6
    expect(s.players[first]!.zones.hand.length).toBe(INITIAL_HAND);
    expect(s.players[second]!.zones.hand.length).toBe(SECOND_PLAYER_HAND);
    // docs/16 §1（D-227）：**先攻首回合自动充能 0 张**，卡组顶不动
    expect(s.players[first]!.zones.cost.length).toBe(0);
    expect(s.players[first]!.zones.deck.length).toBe(MAIN_DECK_SIZE - INITIAL_HAND);
    expect(s.players[second]!.zones.deck.length).toBe(MAIN_DECK_SIZE - SECOND_PLAYER_HAND);
    for (const id of ['p1', 'p2']) {
      const p = s.players[id]!;
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

  it('BO3 第 2 小局：系统 Intent 可指定先手（不掷骰、不消耗随机）', () => {
    const base = fresh();
    const forced: Intent = {
      type: INTENTS.start,
      actor: 'system',
      playerId: 'p1',
      seq: 1,
      payload: { firstPlayerId: 'p2' },
    };
    const r = applyIntent(base, forced, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const started = r.value.find((e) => e.type === 'game:started');
    expect(started?.payload?.['seats']).toEqual(['p2', 'p1']);
    expect(started?.payload?.['forced']).toBe(true);
    // 未掷骰 → 不产出 rng:advance + game:started.rolls
    expect(r.value.some((e) => e.type === 'game:started' && e.payload?.['rolls'])).toBe(false);
  });

  it('玩家 Intent 携带 firstPlayerId 一律忽略（防先后手伪造）', () => {
    const r = applyIntent(
      fresh(),
      intent('p1', INTENTS.start, { firstPlayerId: 'p1' }),
      CTX,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const started = r.value.find((e) => e.type === 'game:started');
    expect(started?.payload?.['forced']).toBeUndefined();
    expect(started?.payload?.['rolls']).toBeDefined();
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

  it('返回 2 张后手牌仍是 5 张、牌库仍是 25 张（30 − 起手 5；先攻首回合 0 充能）', () => {
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

  it('时间窗（Era 2026-10-19）：窗口内可换，过后拒绝 MULLIGAN_EXPIRED（按各自首个充能阶段起算，X-17）', () => {
    const s = started(); // game:started at = CTX.now = 1000 → 先攻方 firstChargeAt = 1000
    const active = s.seats[0]!;

    // 窗口边缘（恰好 30s）仍可用
    const edge = applyIntent(s, intent(active, INTENTS.mulligan, { returns: [] }), {
      ...CTX,
      now: 1000 + MULLIGAN_WINDOW_MS,
    });
    expect(edge.ok).toBe(true);

    // 超过窗口 → 拒绝
    const late = applyIntent(s, intent(active, INTENTS.mulligan, { returns: [] }), {
      ...CTX,
      now: 1000 + MULLIGAN_WINDOW_MS + 1,
    });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error.code).toBe(RULE_ERRORS.MULLIGAN_EXPIRED);
  });

  it('X-17：后攻方在自己的第一个充能阶段（第 2 回合）也能换牌', () => {
    // 后攻方首次拿到回合：turn 2、activeSeat 1、chargeCount 1、firstChargeAt 已写入
    const base = craft({ phase: 'charge', turn: 2, activeSeat: 1 });
    const p2 = base.players['p2']!;
    const s: GameState = {
      ...base,
      players: { ...base.players, p2: { ...p2, chargeCount: 1, firstChargeAt: CTX.now } },
    };
    const after = run(s, intent('p2', INTENTS.mulligan, { returns: [] }));
    expect(after.players['p2']!.mulliganDone).toBe(true);
    expect(after.players['p2']!.zones.hand.length).toBe(INITIAL_HAND);
  });

  it('第二次及以后的充能阶段不可换（每人一次机会，X-17）', () => {
    const base = craft({ phase: 'charge', turn: 3, activeSeat: 0 });
    const p1 = base.players['p1']!;
    const s: GameState = {
      ...base,
      players: { ...base.players, p1: { ...p1, chargeCount: 2, firstChargeAt: CTX.now } },
    };
    const r = applyIntent(s, intent('p1', INTENTS.mulligan, { returns: [] }), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.WRONG_PHASE);
  });
});

/* ------------------------------ 阶段流转 ------------------------------ */

describe('阶段流转 phaseRule', () => {
  it('六阶段顺序固定，逐档推进不跳步（重置瞬穿 + 抽完自动推进，Era 2026-10-18/19）', () => {
    const s0 = craft({ phase: 'charge', turn: 2 });
    // 从充能推进 3 次：抽牌（经重置瞬穿，helper 内补抽牌动作并自动进入主要）→ 战斗 → 结束
    const r = advance(s0, 3);
    const chain = r.events.filter((e) => e.type === 'phase:changed').map((e) => e.payload?.['to']);
    expect(chain).toEqual(['reset', 'draw', 'main', 'battle', 'end']);
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

  it('抽牌不再自动：进入抽牌阶段手牌不变，点击卡组才抽；抽完自动推进（Era 2026-10-18/19）', () => {
    // 充能 →（重置瞬穿）→ 抽牌：一次推进即达抽牌阶段，且**不自动抽**
    let s = run(craft({ phase: 'charge', turn: 2 }), intent('p1', INTENTS.phaseAdvance));
    expect(s.phase).toBe('draw');
    expect(s.drawnThisPhase).toBe(false);
    expect(s.players['p1']!.zones.hand.length).toBe(0);

    // 未抽牌时推进被拒（提示先抽牌）
    const blocked = applyIntent(s, intent('p1', INTENTS.phaseAdvance), CTX);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.message).toContain('抽牌');

    // 点击卡组 → 抽 2 张（A9 补充 1）并**自动推进到主要阶段**（Era 2026-10-19）
    s = run(s, intent('p1', INTENTS.draw));
    expect(s.players['p1']!.zones.hand.length).toBe(2);
    expect(s.phase).toBe('main');

    // 重复抽牌被拒（已不在抽牌阶段）
    const again = applyIntent(s, intent('p1', INTENTS.draw), CTX);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe(RULE_ERRORS.WRONG_PHASE);

    // 主要阶段正常推进
    s = run(s, intent('p1', INTENTS.phaseAdvance));
    expect(s.phase).toBe('battle');
  });

  it('第一回合先攻方点击卡组抽 0 张（docs/16 §1，ADR-0024）', () => {
    let s = run(craft({ phase: 'charge', turn: 1 }), intent('p1', INTENTS.phaseAdvance));
    s = run(s, intent('p1', INTENTS.draw));
    expect(s.players['p1']!.zones.hand.length).toBe(0);
    // 抽 0 张也要走完「抽牌 → 主要」的自动推进
    expect(s.phase).toBe('main');
  });

  it('结束阶段之后进入下一回合：换行动方、回合 +1、最高费用按各自回合数取 1', () => {
    let s = craft({ phase: 'charge', turn: 1, activeSeat: 0 });
    // 重置瞬穿 + 抽完自动推进后，一回合只需 4 次推进：抽牌（抽完自动进主要）→战斗→结束→下一回合充能
    s = advance(s, 4).state;
    expect(s.turn).toBe(2);
    expect(s.activeSeat).toBe(1);
    expect(s.phase).toBe('charge');
    // docs/16 §3.3：双方各自的第一回合上限都是 1（不按全局回合，否则后手白拿一档）
    expect(s.players['p2']!.maxCost).toBe(1);
    expect(s.players['p2']!.chargeCount).toBe(1);
    // 进入充能阶段强制收入 2 张
    expect(s.players['p2']!.zones.cost.length).toBe(COST_INCOME_PER_TURN);
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
  it('随从减费：卡面 2 费实际支付 1 张（docs/16 §4）', () => {
    const s = craft({
      phase: 'main',
      zones: { hand: [c('h1', 'm2')], cost: [c('k1', 'm4'), c('k2', 'm4')] },
    });
    const after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    const p = after.players['p1']!;
    expect(p.zones.board.map((x) => x.uid)).toContain('h1');
    expect(p.zones.cost.length).toBe(1); // 2 - (cost 2 − 1) = 1
    expect(p.zones.graveyard[0]!.uid).toBe('k1'); // 按费用区顺序从前往后取
    expect(p.usedCostThisTurn).toBe(1);
  });

  it('费用区张数不足 → 拒绝 INSUFFICIENT_COST', () => {
    const s = craft({ phase: 'main', zones: { hand: [c('h1', 'm2')], cost: [] } });
    const r = applyIntent(s, intent('p1', INTENTS.play, { uid: 'h1' }), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.INSUFFICIENT_COST);
  });

  it('maxCost 校验：本回合已消耗 + 本次 > 上限 → 拒绝 MAX_COST_EXCEEDED（docs/16 §3.3）', () => {
    const base = craft({
      phase: 'main',
      zones: { hand: [c('h1', 'm2')], cost: [c('k1', 'm4'), c('k2', 'm4')] },
    });
    // 第 2 回合（各自第 2 回合）上限 3；已用 3 → 本次 1 张被拒
    const s: GameState = {
      ...base,
      players: { ...base.players, p1: { ...base.players['p1']!, maxCost: 3, usedCostThisTurn: 3 } },
    };
    const r = applyIntent(s, intent('p1', INTENTS.play, { uid: 'h1' }), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.MAX_COST_EXCEEDED);
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

  it('法术结算后进入弃牌区（设置法术留在法术区）', () => {
    const s = craft({
      phase: 'main',
      zones: { hand: [c('h1', 's1')], cost: [c('k1', 'm4')] },
    });
    const after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    expect(after.players['p1']!.zones.spell.length).toBe(0);
    expect(after.players['p1']!.zones.graveyard.map((x) => x.uid)).toContain('h1');
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

/* ------------------------------ 攻击（ADR-0013） ------------------------------ */

/** 摆一个战斗阶段、第二回合的对局；己方随从与对方随从由参数给。 */
function battle(
  mine: CardInstance,
  foe: CardInstance,
  extra: Partial<{ turn: number; activeSeat: number; phase: Phase; foeExtra: CardInstance[] }> = {},
): GameState {
  return craft({
    phase: extra.phase ?? 'battle',
    turn: extra.turn ?? 2,
    activeSeat: extra.activeSeat ?? 0,
    zones: { board: [mine] },
    foeZones: { board: [foe, ...(extra.foeExtra ?? [])] },
  });
}

describe('攻击裁决 · 纯力量值比较（ADR-0013 §1）', () => {
  it('三分支：大 → 防守方死；小 → 攻击方死；相等 → 双死', () => {
    expect(resolveCombat(5, 3)).toBe('defender');
    expect(resolveCombat(3, 5)).toBe('attacker');
    expect(resolveCombat(4, 4)).toBe('both');
  });
});

describe('攻击 attackRule（ADR-0013）', () => {
  it('攻击方力量值大 → 防守方破坏入弃牌区，攻击方留场', () => {
    // m6(6) vs m3(3)
    const s = battle(c('a1', 'm6'), c('d1', 'm3'));
    const after = run(s, intent('p1', INTENTS.attack, { attackerUid: 'a1', targetUid: 'd1' }));
    expect(after.players['p2']!.zones.board.map((x) => x.uid)).not.toContain('d1');
    expect(after.players['p2']!.zones.graveyard.map((x) => x.uid)).toContain('d1');
    expect(after.players['p1']!.zones.board.map((x) => x.uid)).toContain('a1');
    expect(after.players['p1']!.zones.graveyard.length).toBe(0);
  });

  it('攻击方力量值小 → 攻击方自己破坏', () => {
    // m2(2) vs m9(9)
    const s = battle(c('a1', 'm2'), c('d1', 'm9'));
    const after = run(s, intent('p1', INTENTS.attack, { attackerUid: 'a1', targetUid: 'd1' }));
    expect(after.players['p1']!.zones.board.map((x) => x.uid)).not.toContain('a1');
    expect(after.players['p1']!.zones.graveyard.map((x) => x.uid)).toContain('a1');
    expect(after.players['p2']!.zones.board.map((x) => x.uid)).toContain('d1');
  });

  it('力量值相等 → 双方破坏', () => {
    // m5(5) vs m5(5)
    const s = battle(c('a1', 'm5'), c('d1', 'm5'));
    const after = run(s, intent('p1', INTENTS.attack, { attackerUid: 'a1', targetUid: 'd1' }));
    expect(after.players['p1']!.zones.board.length).toBe(0);
    expect(after.players['p2']!.zones.board.length).toBe(0);
    expect(after.players['p1']!.zones.graveyard.map((x) => x.uid)).toContain('a1');
    expect(after.players['p2']!.zones.graveyard.map((x) => x.uid)).toContain('d1');
  });

  it('攻击后进入休眠态，再次攻击 → 拒绝 UNIT_ASLEEP', () => {
    const s = battle(c('a1', 'm6'), c('d1', 'm3'), { foeExtra: [c('d2', 'm3')] });
    const after = run(s, intent('p1', INTENTS.attack, { attackerUid: 'a1', targetUid: 'd1' }));
    expect(after.players['p1']!.zones.board[0]!.sleeping).toBe(true);
    const r = applyIntent(after, intent('p1', INTENTS.attack, { attackerUid: 'a1', targetUid: 'd2' }), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.UNIT_ASLEEP);
  });

  it('先攻方第一回合攻击 → 拒绝 CANNOT_ATTACK（A10-3）', () => {
    const s = battle(c('a1', 'm6'), c('d1', 'm3'), { turn: 1, activeSeat: 0 });
    const r = applyIntent(s, intent('p1', INTENTS.attack, { attackerUid: 'a1', targetUid: 'd1' }), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.CANNOT_ATTACK);
  });

  it('非战斗阶段攻击 → 拒绝 WRONG_PHASE', () => {
    const s = battle(c('a1', 'm6'), c('d1', 'm3'), { phase: 'main' });
    const r = applyIntent(s, intent('p1', INTENTS.attack, { attackerUid: 'a1', targetUid: 'd1' }), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.WRONG_PHASE);
  });

  it('不是当前行动方 → 拒绝 NOT_YOUR_TURN', () => {
    const s = battle(c('a1', 'm6'), c('d1', 'm3'));
    const r = applyIntent(s, intent('p2', INTENTS.attack, { attackerUid: 'd1', targetUid: 'a1' }), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.NOT_YOUR_TURN);
  });

  it('攻击己方单位 → 拒绝 INVALID_TARGET', () => {
    const s = battle(c('a1', 'm6'), c('d1', 'm3'));
    const r = applyIntent(s, intent('p1', INTENTS.attack, { attackerUid: 'a1', targetUid: 'a1' }), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.INVALID_TARGET);
  });

  it('目标不在随从区 / 指挥官区 → 拒绝 INVALID_TARGET', () => {
    const s = craft({
      phase: 'battle',
      turn: 2,
      zones: { board: [c('a1', 'm6')] },
      foeZones: { hand: [c('h2', 'm3')] },
    });
    const r = applyIntent(s, intent('p1', INTENTS.attack, { attackerUid: 'a1', targetUid: 'h2' }), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.INVALID_TARGET);
  });
});

describe('嘲讽（A7）', () => {
  it('对方有嘲讽随从时打非嘲讽 → 拒绝 MUST_ATTACK_TAUNT', () => {
    const s = battle(c('a1', 'm6'), c('d1', 'm3'), { foeExtra: [c('t1', 'ta1')] });
    const r = applyIntent(s, intent('p1', INTENTS.attack, { attackerUid: 'a1', targetUid: 'd1' }), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.MUST_ATTACK_TAUNT);
  });

  it('打嘲讽随从本身 → 允许（多个嘲讽任选其一，不需要裁决）', () => {
    const s = battle(c('a1', 'm6'), c('t1', 'ta1'), { foeExtra: [c('t2', 'ta1')] });
    const after = run(s, intent('p1', INTENTS.attack, { attackerUid: 'a1', targetUid: 't1' }));
    // m6(6) > ta1(4) → 嘲讽随从破坏
    expect(after.players['p2']!.zones.board.map((x) => x.uid)).not.toContain('t1');
    expect(after.players['p2']!.zones.board.map((x) => x.uid)).toContain('t2');
  });
});

describe('打指挥官 · 伤害与胜负（ADR-0014）', () => {
  /** 己方一个随从，对方指挥官已揭示在对面指挥官区。 */
  function cmdBattle(attacker: CardInstance = c('a1', 'd7')): GameState {
    return craft({
      phase: 'battle',
      turn: 2,
      zones: { board: [attacker] },
      foeZones: { commander: [c('p2#commander', 'cmd')] },
    });
  }

  const hit = (uid = 'a1'): Intent =>
    intent('p1', INTENTS.attack, { attackerUid: uid, targetUid: 'p2#commander' });

  it('力量值大于指挥官 → 按伤害值扣血，指挥官不被破坏', () => {
    // d7：power 7 > cmd 5 → 防守方输；damage 3 → 扣 3
    const after = run(cmdBattle(), hit());
    const foe = after.players['p2']!;
    expect(foe.health).toBe(INITIAL_HEALTH - 3);
    expect(foe.zones.commander.length).toBe(1);
    expect(after.winner).toBeNull();
  });

  it('每点伤害展示 1 张卡组顶的卡并置入费用区（A5 补充 1）', () => {
    const s = cmdBattle();
    const { events, state: after } = runWith(s, hit());
    const foe = after.players['p2']!;
    expect(events.filter((e) => e.type === 'card:revealed').length).toBe(3);
    expect(foe.zones.cost.length).toBe(3);
    expect(foe.zones.deck.length).toBe(s.players['p2']!.zones.deck.length - 3);
  });

  it('展示出来的卡只入费用区，不触发任何效果（效果清单未给）', () => {
    const { events } = runWith(cmdBattle(), hit());
    expect(events.filter((e) => e.type === 'trigger:defend').length).toBe(1);
    expect(events.some((e) => e.type === 'effect:resolved')).toBe(false);
  });

  it('血量清空 → 游戏结束，胜者为攻击方', () => {
    let s = cmdBattle();
    for (let i = 0; i < 5 && s.winner === null; i++) {
      // 攻击后随从会休眠，这里手动重置以连续攻击
      const p1 = s.players['p1']!;
      s = {
        ...s,
        players: {
          ...s.players,
          p1: { ...p1, zones: { ...p1.zones, board: p1.zones.board.map((c) => ({ ...c, sleeping: false })) } },
        },
      };
      s = run(s, hit());
    }
    expect(s.players['p2']!.health).toBe(0);
    expect(s.winner).toBe('p1');
  });

  it('伤害按力量分档：4–6 力打脸 2 点（docs/16 §5.5）', () => {
    // m6 没有 damage 字段、power 6 → 分档 2，不是默认 1
    const after = run(cmdBattle(c('a1', 'm6')), hit());
    expect(after.players['p2']!.health).toBe(INITIAL_HEALTH - 2);
  });

  it('伤害值显式写在卡上时按卡上的值（例外覆盖，§9 第 8 条）', () => {
    // d6：power 6 → 分档 2，但卡面 damage 5 优先
    const after = run(cmdBattle(c('a1', 'd6')), hit());
    expect(after.players['p2']!.health).toBe(INITIAL_HEALTH - 5);
  });

  it('D-227：删除打脸门槛 —— 1 力随从也能直接扣血，且不会自爆', () => {
    // m1：power 2，指挥官 cmd 力量 5 —— 旧规则会被拒/自爆，新规则直接造成 1 点
    const after = run(cmdBattle(c('a1', 'm1')), hit());
    expect(after.players['p2']!.health).toBe(INITIAL_HEALTH - 1);
    expect(after.players['p1']!.zones.board.map((x) => x.uid)).toContain('a1');
  });

  it('前排规则：对方随从区有随从时不能打脸（FRONT_LINE）', () => {
    const s = craft({
      phase: 'battle',
      turn: 2,
      zones: { board: [c('a1', 'd7')] },
      foeZones: {
        commander: [c('p2#commander', 'cmd')],
        board: [{ uid: 'd1', defId: 'm3', sleeping: true }], // 休眠随从也算「有随从」
      },
    });
    const r = applyIntent(s, hit(), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.FRONT_LINE);
  });
});

describe('伤害只作用于指挥官（ADR-0014 §1）', () => {
  it('打随从只破坏、双方血量都不变', () => {
    const s = battle(c('a1', 'm6'), c('d1', 'm3'));
    const after = run(s, intent('p1', INTENTS.attack, { attackerUid: 'a1', targetUid: 'd1' }));
    expect(after.players['p1']!.health).toBe(INITIAL_HEALTH);
    expect(after.players['p2']!.health).toBe(INITIAL_HEALTH);
    expect(after.winner).toBeNull();
  });
});

describe('指挥官攻击（docs/16 §6.1 / ADR-0024）', () => {
  const cmdBattle = (foeExtra: CardInstance[] = []): GameState =>
    craft({
      phase: 'battle',
      turn: 2,
      zones: { commander: [c('p1#commander', 'cmd')] },
      foeZones: { commander: [c('p2#commander', 'cmd')], board: foeExtra },
    });

  it('基础 1 点：不吃自身力量、不受前排限制（对方有随从也能攻击）', () => {
    const s = cmdBattle([c('d1', 'm9')]);
    const after = run(s, intent('p1', INTENTS.commanderAttack));
    expect(after.players['p2']!.health).toBe(INITIAL_HEALTH - 1);
    expect(after.players['p1']!.commanderAttacked).toBe(true);
  });

  it('每回合只能一次 → 第二次拒绝 COMMANDER_ATTACK_USED', () => {
    const s = cmdBattle();
    const after = run(s, intent('p1', INTENTS.commanderAttack));
    const r = applyIntent(after, intent('p1', INTENTS.commanderAttack), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.COMMANDER_ATTACK_USED);
  });

  it('先攻方第一回合不可攻击（A10-3）', () => {
    const s = craft({
      phase: 'battle',
      turn: 1,
      activeSeat: 0,
      zones: { commander: [c('p1#commander', 'cmd')] },
      foeZones: { commander: [c('p2#commander', 'cmd')] },
    });
    const r = applyIntent(s, intent('p1', INTENTS.commanderAttack), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.CANNOT_ATTACK);
  });

  it('指挥官攻击会触发受伤展示（每 1 点展示 1 张进费用区）', () => {
    const s = cmdBattle();
    const { events } = runWith(s, intent('p1', INTENTS.commanderAttack));
    expect(events.filter((e) => e.type === 'card:revealed').length).toBe(1);
  });

  /**
   * Era 2026-10-19 拍板（docs/16 §9 #9 由「不会」改为「会」，H34 已确认）：
   * 指挥官的基础 1 点**进入伤害修正**，可被「你的指挥官伤害值 +N」类效果提升。
   */
  it('基础 1 点可被「指挥官伤害值 +N」提升（H34 已确认）', () => {
    const s = cmdBattle();
    const buffed: GameState = {
      ...s,
      players: { ...s.players, p1: { ...s.players['p1']!, commanderDamageBonus: 2 } },
    };
    const { events, state: after } = runWith(buffed, intent('p1', INTENTS.commanderAttack));
    expect(after.players['p2']!.health).toBe(INITIAL_HEALTH - 3);
    // 加成后的每 1 点照样触发受伤展示
    expect(events.filter((e) => e.type === 'card:revealed').length).toBe(3);
    expect(after.players['p2']!.zones.cost.length).toBe(3);
  });

  it('随从实例上的 tempDamage 不转移给指挥官（统领 7 档只加该随从打脸）', () => {
    const s = cmdBattle();
    const p1 = s.players['p1']!;
    const withTemp: GameState = {
      ...s,
      players: {
        ...s.players,
        p1: {
          ...p1,
          zones: { ...p1.zones, board: [{ ...c('a1', 'd7'), tempDamage: 5 }] },
        },
      },
    };
    const after = run(withTemp, intent('p1', INTENTS.commanderAttack));
    expect(after.players['p2']!.health).toBe(INITIAL_HEALTH - 1);
  });
});

describe('攻击的事件序列与触发点（ADR-0013 §7）', () => {
  it('声明 → 攻击时触发 → 被攻击时触发 → 裁决，顺序固定', () => {
    const s = battle(c('a1', 'm6'), c('d1', 'm3'));
    const { events } = runWith(s, intent('p1', INTENTS.attack, { attackerUid: 'a1', targetUid: 'd1' }));
    const types = events.map((e) => e.type);
    expect(types.slice(0, 4)).toEqual([
      'attack:declared',
      'trigger:attack',
      'trigger:defend',
      'combat:resolved',
    ]);
  });

  it('combat:resolved 携带双方力量值快照与裁决结果', () => {
    const s = battle(c('a1', 'm6'), c('d1', 'm3'));
    const { events } = runWith(s, intent('p1', INTENTS.attack, { attackerUid: 'a1', targetUid: 'd1' }));
    const resolved = events.find((e) => e.type === 'combat:resolved');
    expect(resolved).toBeDefined();
    expect(resolved!.payload).toMatchObject({ atkPower: 6, defPower: 3, outcome: 'defender' });
  });

  it('卡池查不到定义 → 拒绝 CARD_NOT_FOUND（不静默按 0 处理）', () => {
    const s = battle(c('a1', 'ghost'), c('d1', 'm3'));
    const r = applyIntent(s, intent('p1', INTENTS.attack, { attackerUid: 'a1', targetUid: 'd1' }), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.CARD_NOT_FOUND);
  });
});

/* ------------------ 指挥官力量值曲线（X-7 / ADR-0016） ------------------ */

/** 连续推进 `times` 次阶段。 */
function advance(state: GameState, times: number, ctx: RuleContext = CTX) {
  let s = state;
  const events: GameEvent[] = [];
  for (let i = 0; i < times; i++) {
    // 抽牌手动化（Era 2026-10-18）：未抽牌的抽牌阶段禁止推进，先补抽牌动作。
    if (s.phase === 'draw' && !s.drawnThisPhase) {
      const d = applyIntent(s, intent(s.seats[s.activeSeat]!, INTENTS.draw), ctx);
      if (!d.ok) throw new Error(`意外拒绝（抽牌）: ${d.error.code} ${d.error.message}`);
      events.push(...d.value);
      s = d.value.reduce(reduce, s);
    }
    const r = applyIntent(s, intent(s.seats[s.activeSeat]!, INTENTS.phaseAdvance), ctx);
    if (!r.ok) throw new Error(`意外拒绝: ${r.error.code} ${r.error.message}`);
    events.push(...r.value);
    s = r.value.reduce(reduce, s);
  }
  return { state: s, events };
}

describe('指挥官没有力量值（docs/16 §6.2.1 / D-230）', () => {
  function startWithCurve() {
    const s = createInitialState({
      seed: 7,
      seats: ['p1', 'p2'],
      decks: { p1: DECK, p2: DECK },
      commanders: { p1: 'cmdCurve', p2: 'cmdCurve' },
    });
    return runWith(s, intent('p1', INTENTS.start));
  }

  it('开局不再产出成长事件，档位停在初始值', () => {
    const { state: after, events } = startWithCurve();
    expect(events.filter((e) => e.type === 'commander:grown')).toHaveLength(0);
    for (const id of after.seats) {
      expect(after.players[id]!.commanderPowerIndex).toBe(0);
    }
  });

  it('力量值恒为 CardDef.power，不随回合/轮次推进（powerCurve 只作历史字段）', () => {
    const { state: s0 } = startWithCurve();
    const uid = `${s0.seats[0]!}#commander`;
    expect(unitPower(s0, CARDS, uid)).toBe(0);
    expect(unitPower(advance(s0, 12).state, CARDS, uid)).toBe(0);
    expect(unitPower(advance(s0, 28).state, CARDS, uid)).toBe(0);
  });

  it('打脸不读指挥官任何数值 —— 任意局面都直接扣 1 点（D-227）', () => {
    const s = craft({
      phase: 'battle',
      turn: 4,
      activeSeat: 1,
      zones: { commander: [c('p1#commander', 'cmdCurve')] },
      foeZones: { board: [c('d1', 'm1')] },
    });
    const after = run(s, intent('p2', INTENTS.attack, { attackerUid: 'd1', targetUid: 'p1#commander' }));
    expect(after.players['p1']!.health).toBe(INITIAL_HEALTH - 1);
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
        // 手动抽牌（Era 2026-10-18）：抽牌阶段先抽再推进
        if (s.phase === 'draw' && !s.drawnThisPhase) {
          s = run(s, intent(s.seats[s.activeSeat]!, INTENTS.draw), { now: 3 + i, cards: CARDS });
        }
        s = run(s, intent(s.seats[s.activeSeat]!, INTENTS.phaseAdvance), { now: 3 + i, cards: CARDS });
      }
      return s;
    };
    expect(stateHash(seq(fresh()))).toBe(stateHash(seq(fresh())));
  });
});
