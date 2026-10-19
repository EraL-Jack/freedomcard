/**
 * 专属成长资源与星轨展示机制（D-229 / D-230）。
 *
 * 覆盖三块：
 *  1. **霜痕**：冻结敌方随从即 +1 层，永久累积；裁决官Ⅰ 按 3/6/9 分档；
 *  2. **星轨**：展示即 +1 层；指挥官攻击付费展示 2/3/4 张；
 *  3. **展示时**效果：星轨随从/法术在「没被打出」时的结算边界。
 */

import { describe, expect, it } from 'vitest';

import type { CardInstance, GameState, Intent, Phase, Zone } from '@app/shared';
import { CARD_POOL } from '@app/shared/cards';

import { applyIntent, createInitialState, reduce, INTENTS } from '../index.js';
import { freezeUnit } from '../effects/primitives.js';
import { revealCountFor } from '../effects/star-commander.js';
import { unitPower } from '../ops.js';

const CTX = { now: 1000, cards: CARD_POOL };
const c = (uid: string, defId: string, extra: Partial<CardInstance> = {}): CardInstance => ({
  uid,
  defId,
  ...extra,
});
const intent = (playerId: string, type: string, payload?: Record<string, unknown>): Intent => ({
  type,
  actor: 'player',
  playerId,
  seq: 1,
  payload,
});

function run(state: GameState, it_: Intent): GameState {
  const r = applyIntent(state, it_, CTX);
  if (!r.ok) throw new Error(`意外拒绝: ${r.error.code} ${r.error.message}`);
  let s = state;
  for (const e of r.value) s = reduce(s, e);
  return s;
}

/** 造一个确定场面：p1 行动、p2 是对手。默认指挥官为霜律裁决官。 */
function craft(patch: {
  phase?: Phase;
  turn?: number;
  activeSeat?: number;
  zones?: Partial<Record<Zone, CardInstance[]>>;
  foeZones?: Partial<Record<Zone, CardInstance[]>>;
  commander?: string;
  foeCommander?: string;
  deck?: readonly string[];
  mark?: number;
  star?: number;
}): GameState {
  const deck = patch.deck ?? Array.from({ length: 30 }, () => 'frostRecruit');
  const s = createInitialState({
    seed: 1,
    seats: ['p1', 'p2'],
    decks: { p1: deck, p2: deck },
    commanders: {
      p1: patch.commander ?? 'frostAdjudicator',
      p2: patch.foeCommander ?? 'bladeLord',
    },
  });
  let out: GameState = {
    ...s,
    started: true,
    phase: patch.phase ?? 'main',
    turn: patch.turn ?? 2,
    activeSeat: patch.activeSeat ?? 0,
    players: {
      p1: { ...s.players['p1']!, maxCost: 10, frostMark: patch.mark ?? 0, starTrack: patch.star ?? 0 },
      p2: { ...s.players['p2']!, maxCost: 10 },
    },
  };
  if (patch.zones) {
    out = { ...out, players: { ...out.players, p1: { ...out.players['p1']!, zones: { ...out.players['p1']!.zones, ...patch.zones } } } };
  }
  if (patch.foeZones) {
    out = { ...out, players: { ...out.players, p2: { ...out.players['p2']!, zones: { ...out.players['p2']!.zones, ...patch.foeZones } } } };
  }
  return out;
}

/* ------------------------------ 霜痕 ------------------------------ */

describe('霜痕（docs/16 §6.3.2 / D-229）', () => {
  it('冻结一个敌方随从 → 获得 1 层霜痕，永久累积（回合切换不清零）', () => {
    const s = craft({
      zones: { hand: [c('h1', 'frostApprentice')], cost: [c('k1', 'frostRecruit')] },
      foeZones: { board: [c('f1', 'bladeVanguard')] },
    });
    const s1 = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    expect(s1.pendingChoice?.kind).toBe('frost-apprentice-freeze');
    const after = run(s1, intent('p1', INTENTS.effectChoose, { choice: 'f1' }));
    expect(after.players['p1']!.frostMark).toBe(1);
    expect(after.players['p2']!.zones.board[0]!.frozen).toBe(true);

    // 回合切换（turn:changed）不清零成长资源
    const next = reduce(after, { type: 'turn:changed', at: 2000, payload: { turn: 3, activeSeat: 1 } });
    expect(next.players['p1']!.frostMark).toBe(1);
  });

  it('裁决官Ⅰ 0–2 层：付 2 费，冻结 1 个，不抽牌', () => {
    const s = craft({
      zones: { commander: [c('cmd1', 'frostAdjudicator')], cost: [c('k1', 'frostRecruit'), c('k2', 'frostRecruit')] },
      foeZones: { board: [c('f1', 'bladeVanguard'), c('f2', 'bladeVanguard')] },
      mark: 2,
    });
    const s1 = run(s, intent('p1', INTENTS.effectActivate, { uid: 'cmd1', effect: '1' }));
    expect(s1.pendingChoice?.kind).toBe('frost-adjudicator-1');
    const handBefore = s1.players['p1']!.zones.hand.length;
    const s2 = run(s1, intent('p1', INTENTS.effectChoose, { choice: 'f1' }));
    expect(s2.pendingChoice).toBeNull();
    expect(s2.players['p2']!.zones.board.find((x) => x.uid === 'f1')!.frozen).toBe(true);
    // 只冻结 1 个：第二个目标仍未冻结
    expect(s2.players['p2']!.zones.board.find((x) => x.uid === 'f2')!.frozen).toBeFalsy();
    // 0–2 层不抽牌（冻结触发的裁决官Ⅱ会抽 1，那是另一条被动）
    expect(s2.players['p1']!.zones.hand.length).toBe(handBefore + 1);
  });

  it('裁决官Ⅰ 6–8 层：冻结 2 个（连续两次选择）', () => {
    const s = craft({
      zones: { commander: [c('cmd1', 'frostAdjudicator')], cost: [c('k1', 'frostRecruit'), c('k2', 'frostRecruit')] },
      foeZones: { board: [c('f1', 'bladeVanguard'), c('f2', 'bladeVanguard'), c('f3', 'bladeVanguard')] },
      mark: 6,
    });
    const s1 = run(s, intent('p1', INTENTS.effectActivate, { uid: 'cmd1', effect: '1' }));
    const s2 = run(s1, intent('p1', INTENTS.effectChoose, { choice: 'f1' }));
    // 还需要第二个目标 → 仍处于选择中，且候选里没有已冻的 f1
    expect(s2.pendingChoice?.kind).toBe('frost-adjudicator-1');
    expect(s2.pendingChoice?.options).toEqual(['f2', 'f3']);
    const s3 = run(s2, intent('p1', INTENTS.effectChoose, { choice: 'f2' }));
    expect(s3.pendingChoice).toBeNull();
    expect(s3.players['p2']!.zones.board.filter((x) => x.frozen).map((x) => x.uid)).toEqual(['f1', 'f2']);
  });

  it('裁决官Ⅰ 9 层及以上：冻结 2 个 + 抽 1 张（档位函数）', () => {
    const s = craft({
      zones: { commander: [c('cmd1', 'frostAdjudicator')], cost: [c('k1', 'frostRecruit'), c('k2', 'frostRecruit')] },
      foeZones: { board: [c('f1', 'bladeVanguard'), c('f2', 'bladeVanguard')] },
      mark: 9,
    });
    const handBefore = s.players['p1']!.zones.hand.length;
    let st = run(s, intent('p1', INTENTS.effectActivate, { uid: 'cmd1', effect: '1' }));
    st = run(st, intent('p1', INTENTS.effectChoose, { choice: 'f1' }));
    st = run(st, intent('p1', INTENTS.effectChoose, { choice: 'f2' }));
    // 两次冻结各触发一次裁决官Ⅱ？—— Ⅱ 每回合一次，只抽 1；再加档位的抽 1 → 共 2 张
    expect(st.players['p1']!.zones.hand.length).toBe(handBefore + 2);
  });
});

/* -------------------- 冻结目标必须是「未冻结」（H31） -------------------- */

describe('H31：冻结目标限未冻结单位（Era 2026-10-19）', () => {
  it('学徒登场时若目标已冻结 → 不弹选择、不加霜痕', () => {
    const s = craft({
      zones: { hand: [c('h1', 'frostApprentice')] },
      foeZones: { board: [c('f1', 'bladeVanguard', { frozen: true })] },
    });
    const after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    expect(after.pendingChoice).toBeNull();
    expect(after.players['p1']!.frostMark).toBe(0);
    expect(after.players['p2']!.zones.board[0]!.frozen).toBe(true);
  });

  it('候选列表里不含已冻结单位（2 个目标只剩 1 个可选）', () => {
    const s = craft({
      zones: { hand: [c('h1', 'frostApprentice')] },
      foeZones: { board: [c('f1', 'bladeVanguard', { frozen: true }), c('f2', 'bladeVanguard')] },
    });
    const after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    expect(after.pendingChoice?.options).toEqual(['f2']);
  });

  it('freezeUnit 对已冻结目标直接返回空（兜底：不发 unit:frozen、不加霜痕）', () => {
    const s = craft({
      zones: { commander: [c('cmd1', 'frostAdjudicator')] },
      foeZones: { board: [c('f1', 'bladeVanguard', { frozen: true })] },
    });
    const r = freezeUnit(CTX.now, s, 'p1', 'f1', CARD_POOL);
    expect(r.events).toEqual([]);
    expect(r.state).toBe(s);
  });

  it('缚锁者是卡面例外：选已冻结单位 → 抽 1 张，不产生冻结', () => {
    const s = craft({
      zones: { hand: [c('h1', 'frostBinder')], cost: [c('k1', 'frostRecruit')] },
      foeZones: { board: [c('f1', 'bladeVanguard', { frozen: true })] },
    });
    const s1 = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    expect(s1.pendingChoice?.kind).toBe('frost-binder-freeze');
    const handBefore = s1.players['p1']!.zones.hand.length;
    const after = run(s1, intent('p1', INTENTS.effectChoose, { choice: 'f1' }));
    expect(after.players['p1']!.zones.hand.length).toBe(handBefore + 1);
    expect(after.players['p1']!.frostMark).toBe(0);
  });
});

/* ------------------------------ 星轨 ------------------------------ */

describe('星轨（docs/17 / D-230）', () => {
  it('档位：0–2 层展示 2 张，3–5 层 3 张，6 层及以上 4 张', () => {
    expect(revealCountFor(0)).toBe(2);
    expect(revealCountFor(2)).toBe(2);
    expect(revealCountFor(3)).toBe(3);
    expect(revealCountFor(5)).toBe(3);
    expect(revealCountFor(6)).toBe(4);
    expect(revealCountFor(99)).toBe(4);
  });

  it('星图：展示 1 张 → 星轨 +1、该卡回到牌库底（不进手牌、不进墓地）', () => {
    const s = craft({
      commander: 'starWatcher',
      zones: {
        commander: [c('cmd1', 'starWatcher')],
        hand: [c('h1', 'starChart')],
        cost: [c('k1', 'frostRecruit'), c('k2', 'frostRecruit')],
      },
      deck: ['starScout', 'frostRecruit', 'frostRecruit'],
    });
    const topUid = s.players['p1']!.zones.deck[0]!.uid;
    const after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    const deck = after.players['p1']!.zones.deck;
    // 展示后置底：该卡仍在牌库里，且不在顶部
    expect(deck.some((x) => x.uid === topUid)).toBe(true);
    expect(deck[0]!.uid).not.toBe(topUid);
    expect(after.players['p1']!.zones.hand.some((x) => x.uid === topUid)).toBe(false);
    expect(after.players['p1']!.zones.graveyard.some((x) => x.uid === topUid)).toBe(false);
    // 星轨：展示 1 张 + 斥候自身的「展示时：获得 1 层」= 2
    expect(after.players['p1']!.starTrack).toBe(2);
  });

  it('指挥官攻击（付 1 费展示）：先展示再结算 1 点伤害', () => {
    const s = craft({
      phase: 'battle',
      commander: 'starWatcher',
      zones: { commander: [c('cmd1', 'starWatcher')], cost: [c('k1', 'frostRecruit')] },
      deck: ['frostRecruit', 'frostRecruit', 'frostRecruit'],
      star: 0,
    });
    const after = run(s, intent('p1', INTENTS.commanderAttack, { reveal: true }));
    expect(after.players['p1']!.zones.cost.length).toBe(0); // 付了 1 张
    expect(after.players['p1']!.commanderAttacked).toBe(true);
    expect(after.players['p1']!.starTrack).toBe(2); // 展示 2 张
    expect(after.players['p2']!.health).toBe(7); // 1 点伤害
  });

  it('不带 reveal 的攻击不展示、不付费', () => {
    const s = craft({
      phase: 'battle',
      commander: 'starWatcher',
      zones: { commander: [c('cmd1', 'starWatcher')], cost: [c('k1', 'frostRecruit')] },
      star: 0,
    });
    const after = run(s, intent('p1', INTENTS.commanderAttack));
    expect(after.players['p1']!.zones.cost.length).toBe(1);
    expect(after.players['p1']!.starTrack).toBe(0);
    expect(after.players['p2']!.health).toBe(7);
  });

  it('星轨侍僧：展示时给指挥官 +1 伤害（不可叠加）', () => {
    const s = craft({
      phase: 'battle',
      commander: 'starWatcher',
      zones: { commander: [c('cmd1', 'starWatcher')], cost: [c('k1', 'frostRecruit'), c('k2', 'frostRecruit')] },
      deck: ['starAcolyte', 'starAcolyte'],
      star: 0,
    });
    const after = run(s, intent('p1', INTENTS.commanderAttack, { reveal: true }));
    // 翻到两张侍僧，但「不可叠加」→ 只 +1；指挥官伤害 1 + 1 = 2
    expect(after.players['p1']!.commanderDamageBonus).toBe(1);
    expect(after.players['p2']!.health).toBe(6);
  });

  it('星轨织者：展示时召唤 1/1 星灵（衍生物进随从区）', () => {
    const s = craft({
      commander: 'starWatcher',
      zones: {
        commander: [c('cmd1', 'starWatcher')],
        hand: [c('h1', 'starChart')],
        cost: [c('k1', 'frostRecruit'), c('k2', 'frostRecruit')],
      },
      deck: ['starWeaver', 'frostRecruit'],
    });
    const after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    const spirits = after.players['p1']!.zones.board.filter((x) => x.defId === 'starSpirit1');
    expect(spirits).toHaveLength(1);
    expect(unitPower(after, CARD_POOL, spirits[0]!.uid)).toBe(1);
  });

  it('展示时挂上的「登场 +N」在登场那一刻变成力量值（docs/17 §6.3 方案 A）', () => {
    // 模拟「枪手曾被展示、但仍在手牌」：暂存位挂在实例上。
    const s = craft({
      commander: 'starWatcher',
      zones: {
        hand: [c('h1', 'starLancer', { pendingPowerBuff: 2 })],
        cost: [c('k1', 'frostRecruit'), c('k2', 'frostRecruit')],
      },
    });
    const after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    const lancer = after.players['p1']!.zones.board[0]!;
    expect(lancer.uid).toBe('h1');
    expect(lancer.pendingPowerBuff).toBeUndefined(); // 已消费
    expect(lancer.tempPower).toBe(2);
    expect(unitPower(after, CARD_POOL, 'h1')).toBe(5); // 3 + 2
  });

  it('凝视星空：展示 2 张后选 1 张进手牌，其余留在牌库底', () => {
    const s = craft({
      commander: 'starWatcher',
      zones: {
        commander: [c('cmd1', 'starWatcher')],
        hand: [c('h1', 'starGaze')],
        cost: [c('k1', 'frostRecruit'), c('k2', 'frostRecruit'), c('k3', 'frostRecruit')],
      },
      deck: ['frostRecruit', 'frostRecruit', 'frostRecruit', 'frostRecruit'],
    });
    const revealedUids = s.players['p1']!.zones.deck.slice(0, 2).map((x) => x.uid);
    const s1 = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    expect(s1.pendingChoice?.kind).toBe('star-gaze-pick');
    expect(s1.pendingChoice?.options).toEqual(revealedUids);
    const s2 = run(s1, intent('p1', INTENTS.effectChoose, { choice: revealedUids[0]! }));
    expect(s2.players['p1']!.zones.hand.map((x) => x.uid)).toContain(revealedUids[0]);
    // 另一张仍在牌库
    expect(s2.players['p1']!.zones.deck.map((x) => x.uid)).toContain(revealedUids[1]);
  });

  it('星轨传令：展示时下一张随从费用 -1（打出后消耗）', () => {
    const s = craft({
      commander: 'starWatcher',
      zones: {
        commander: [c('cmd1', 'starWatcher')],
        hand: [c('h1', 'starChart'), c('h2', 'bladeKnight')],
        cost: [c('k1', 'frostRecruit'), c('k2', 'frostRecruit'), c('k3', 'frostRecruit')],
      },
      deck: ['starHerald', 'frostRecruit'],
    });
    let st = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    expect(st.players['p1']!.nextMinionDiscount).toBe(1);
    // bladeKnight 卡面 3 费，随从减 1 = 2；再减 1 = 1
    const before = st.players['p1']!.zones.cost.length;
    st = run(st, intent('p1', INTENTS.play, { uid: 'h2' }));
    expect(before - st.players['p1']!.zones.cost.length).toBe(1);
    expect(st.players['p1']!.nextMinionDiscount).toBe(0);
  });
});
