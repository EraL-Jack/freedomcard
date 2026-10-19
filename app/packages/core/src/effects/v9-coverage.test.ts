/**
 * 卡池覆盖补齐（D-153）—— 45 张卡里此前**没有任何测试引用**的 14 张。
 *
 * 来源：按 `CARD_POOL` 的 defId 反查测试文件，这些卡一次都没出现过。
 * 它们不是新卡，只是「写得早、测漏了」—— 而漏测的效果往往是最容易悄悄坏掉的那类：
 * 光环、被攻击时修正、每回合额度、展示时召唤、设置法术的每回合一次。
 *
 * 与 `v8-cards.test.ts` 的分工：那边测规则边界（费用 / 前排 / 冻结解除），
 * 这里逐张钉「卡面写的效果确实发生了」。
 */

import { describe, expect, it } from 'vitest';

import type { CardInstance, GameEvent, GameState, Intent, Phase, Zone } from '@app/shared';
import { CARD_POOL } from '@app/shared/cards';

import { applyIntent, createInitialState, reduce, INTENTS } from '../index.js';
import { freezeUnit } from '../effects/primitives.js';
import { starRevealEvents } from '../effects/index.js';
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

/** 直接跑一组事件（用于绕过 Intent 层，只测效果原语）。 */
function apply(state: GameState, events: readonly GameEvent[]): GameState {
  let s = state;
  for (const e of events) s = reduce(s, e);
  return s;
}

/** 造一个确定场面：p1 行动、p2 是对手。 */
function craft(patch: {
  phase?: Phase;
  turn?: number;
  activeSeat?: number;
  zones?: Partial<Record<Zone, CardInstance[]>>;
  foeZones?: Partial<Record<Zone, CardInstance[]>>;
  commander?: string;
  foeCommander?: string;
  deck?: readonly string[];
  star?: number;
  bonus?: number;
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
      p1: {
        ...s.players['p1']!,
        maxCost: 10,
        starTrack: patch.star ?? 0,
        commanderDamageBonus: patch.bonus ?? 0,
      },
      p2: { ...s.players['p2']!, maxCost: 10 },
    },
  };
  if (patch.zones) {
    out = {
      ...out,
      players: {
        ...out.players,
        p1: { ...out.players['p1']!, zones: { ...out.players['p1']!.zones, ...patch.zones } },
      },
    };
  }
  if (patch.foeZones) {
    out = {
      ...out,
      players: {
        ...out.players,
        p2: { ...out.players['p2']!, zones: { ...out.players['p2']!.zones, ...patch.foeZones } },
      },
    };
  }
  return out;
}

const power = (s: GameState, uid: string): number => unitPower(s, CARD_POOL, uid) ?? -1;

/* ------------------------------ 炎刃 ------------------------------ */

describe('炎刃队长：其他炎刃随从登场 +1', () => {
  it('场上已有队长时，新登场的炎刃随从本回合力量 +1', () => {
    const s = craft({
      zones: { board: [c('cap', 'bladeCaptain')], hand: [c('h1', 'bladeScout')] },
    });
    const after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    // bladeScout 基础力量 1 → 队长光环 +1 = 2
    expect(power(after, 'h1')).toBe(CARD_POOL['bladeScout']!.power + 1);
  });

  it('队长自己登场不加（卡面「**其他**己方炎刃随从」）', () => {
    const s = craft({ zones: { hand: [c('h1', 'bladeCaptain')], cost: [c('k1', 'bladeRecruit'), c('k2', 'bladeRecruit'), c('k3', 'bladeRecruit')] } });
    const after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    expect(power(after, 'h1')).toBe(CARD_POOL['bladeCaptain']!.power);
  });
});

/* ------------------------------ 霜律 ------------------------------ */

describe('霜律戍卫：被攻击时攻击者本回合 −1', () => {
  it('攻击戍卫的随从力量值下降 1 点', () => {
    const s = craft({
      phase: 'battle',
      zones: { board: [c('a1', 'bladeVanguard')] },
      foeZones: { board: [c('w1', 'frostWarden')] },
    });
    const after = run(s, intent('p1', INTENTS.attack, { attackerUid: 'a1', targetUid: 'w1' }));
    expect(power(after, 'a1')).toBe(CARD_POOL['bladeVanguard']!.power - 1);
  });
});

describe('霜律长枪兵：攻击冻结目标时力量 +2', () => {
  it('裁决快照里攻击力是 基础+2', () => {
    const s = craft({
      phase: 'battle',
      zones: { board: [c('l1', 'frostLancer')] },
      foeZones: { board: [c('f1', 'bladeVanguard', { frozen: true })] },
    });
    const r = applyIntent(s, intent('p1', INTENTS.attack, { attackerUid: 'l1', targetUid: 'f1' }), CTX);
    if (!r.ok) throw new Error('attack rejected');
    const combat = r.value.find((e) => e.type === 'combat:resolved');
    expect(Number(combat?.payload?.['atkPower'])).toBe(CARD_POOL['frostLancer']!.power + 2);
  });
});

describe('霜律执法者：冻结时 +1，每回合最多 +2，回合切换清零', () => {
  it('前两次各 +1，第三次不再加；新回合重新可用', () => {
    const s = craft({
      zones: { board: [c('e1', 'frostEnforcer')] },
      foeZones: {
        board: [c('f1', 'bladeRecruit'), c('f2', 'bladeRecruit'), c('f3', 'bladeRecruit'), c('f4', 'bladeRecruit')],
      },
    });
    const base = CARD_POOL['frostEnforcer']!.power;

    let st = s;
    for (const uid of ['f1', 'f2', 'f3']) {
      st = apply(st, freezeUnit(CTX.now, st, 'p1', uid, CARD_POOL).events);
    }
    expect(power(st, 'e1')).toBe(base + 2); // 第三次被额度挡住

    // 回合切换：tempPower 与「每回合额度」一起清零（额度发到**拿到回合**的人，故走完一整圈）
    st = apply(st, [
      { type: 'turn:changed', at: 2000, payload: { turn: 3, activeSeat: 1 } },
      { type: 'turn:changed', at: 3000, payload: { turn: 4, activeSeat: 0 } },
    ]);
    expect(power(st, 'e1')).toBe(base);

    st = apply(st, freezeUnit(CTX.now, st, 'p1', 'f4', CARD_POOL).events);
    expect(power(st, 'e1')).toBe(base + 1);
  });
});

describe('霜律守夜人：登场冻结至多 2 个未冻结的敌方随从', () => {
  it('连选两个目标，都进入冻结', () => {
    const s = craft({
      zones: {
        hand: [c('h1', 'frostNightwatch')],
        cost: [c('k1', 'frostRecruit'), c('k2', 'frostRecruit'), c('k3', 'frostRecruit')],
      },
      foeZones: { board: [c('f1', 'bladeRecruit'), c('f2', 'bladeRecruit'), c('f3', 'bladeRecruit')] },
    });
    let after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    expect(after.pendingChoice?.kind).toBe('frost-nightwatch-freeze');
    after = run(after, intent('p1', INTENTS.effectChoose, { choice: 'f1' }));
    after = run(after, intent('p1', INTENTS.effectChoose, { choice: 'f2' }));

    const frozen = after.players['p2']!.zones.board.filter((x) => x.frozen).map((x) => x.uid);
    expect(frozen).toEqual(['f1', 'f2']);
    expect(after.pendingChoice).toBeNull(); // 用满 2 次即自动结束，不需要「完成选择」
  });
});

describe('霜律凛冬之刃：登场冻结所有敌方随从', () => {
  it('不弹选择，全部冻结', () => {
    const s = craft({
      zones: {
        hand: [c('h1', 'frostWinterblade')],
        cost: [1, 2, 3, 4, 5].map((i) => c(`k${i}`, 'frostRecruit')),
      },
      foeZones: { board: [c('f1', 'bladeRecruit'), c('f2', 'bladeRecruit')] },
    });
    const after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    expect(after.pendingChoice).toBeNull();
    expect(after.players['p2']!.zones.board.every((x) => x.frozen)).toBe(true);
  });
});

describe('霜律律令：冻结 1 个；力量 ≥4 时抽 1 张', () => {
  it('高力量目标 → 冻结并抽牌', () => {
    const s = craft({
      zones: { hand: [c('h1', 'frostEdict')], cost: [c('k1', 'frostRecruit')] },
      foeZones: { board: [c('f1', 'frostWinterblade')] },
    });
    const before = s.players['p1']!.zones.hand.length;
    let after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    expect(after.pendingChoice?.kind).toBe('frost-edict-freeze');
    after = run(after, intent('p1', INTENTS.effectChoose, { choice: 'f1' }));
    expect(after.players['p2']!.zones.board[0]!.frozen).toBe(true);
    // 打出的那张离开手牌 → 抽 1 补回，净额不变
    expect(after.players['p1']!.zones.hand.length).toBe(before);
  });

  it('低力量目标 → 只冻结，不抽牌', () => {
    const s = craft({
      zones: { hand: [c('h1', 'frostEdict')], cost: [c('k1', 'frostRecruit')] },
      foeZones: { board: [c('f1', 'bladeRecruit')] },
    });
    const before = s.players['p1']!.zones.hand.length;
    let after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    after = run(after, intent('p1', INTENTS.effectChoose, { choice: 'f1' }));
    expect(after.players['p2']!.zones.board[0]!.frozen).toBe(true);
    expect(after.players['p1']!.zones.hand.length).toBe(before - 1); // 打出去 1 张，没抽
  });
});

describe('霜律寒流：冻结至多 2 个未冻结的敌方随从', () => {
  it('选两个，第三个不动', () => {
    const s = craft({
      zones: { hand: [c('h1', 'frostColdSnap')], cost: [c('k1', 'frostRecruit'), c('k2', 'frostRecruit')] },
      foeZones: { board: [c('f1', 'bladeRecruit'), c('f2', 'bladeRecruit'), c('f3', 'bladeRecruit')] },
    });
    let after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    expect(after.pendingChoice?.kind).toBe('frost-coldsnap-freeze');
    after = run(after, intent('p1', INTENTS.effectChoose, { choice: 'f1' }));
    after = run(after, intent('p1', INTENTS.effectChoose, { choice: 'f3' }));
    expect(after.players['p2']!.zones.board.map((x) => !!x.frozen)).toEqual([true, false, true]);
  });
});

/* ------------------------------ 星轨 ------------------------------ */

describe('星轨巨像：展示时本回合力量 +1（不在场则暂存到登场）', () => {
  it('被展示时挂上 pendingPowerBuff', () => {
    const s = craft({
      phase: 'battle',
      commander: 'starWatcher',
      star: 1,
      deck: ['starGiant', 'frostRecruit', 'frostRecruit', 'frostRecruit', 'frostRecruit'],
      zones: { commander: [c('cmd1', 'starWatcher')], cost: [c('k1', 'frostRecruit')] },
    });
    const after = run(s, intent('p1', INTENTS.commanderAttack, { reveal: true }));
    const giant = after.players['p1']!.zones.deck.find((x) => x.defId === 'starGiant');
    expect(giant?.pendingPowerBuff).toBe(1);
  });
});

describe('星轨君王：展示时召唤 1 个星灵（3/3）', () => {
  it('展示后随从区出现 starSpirit3', () => {
    const s = craft({
      phase: 'battle',
      commander: 'starWatcher',
      star: 1,
      deck: ['starSovereign', 'frostRecruit', 'frostRecruit', 'frostRecruit', 'frostRecruit'],
      zones: { commander: [c('cmd1', 'starWatcher')], cost: [c('k1', 'frostRecruit')] },
    });
    const after = run(s, intent('p1', INTENTS.commanderAttack, { reveal: true }));
    expect(after.players['p1']!.zones.board.map((x) => x.defId)).toContain('starSpirit3');
  });
});

describe('星陨：固定 2 点直伤（不吃指挥官伤害加成）', () => {
  it('指挥官伤害 +5 时仍然只打 2 点', () => {
    const s = craft({
      zones: { hand: [c('h1', 'starFall')], cost: [c('k1', 'frostRecruit'), c('k2', 'frostRecruit')] },
      bonus: 5,
    });
    const after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    expect(after.players['p2']!.health).toBe(6);
  });
});

describe('星赐：本回合所有己方随从力量 +1', () => {
  it('场上每个随从都 +1', () => {
    const s = craft({
      zones: {
        hand: [c('h1', 'starBlessing')],
        cost: [c('k1', 'frostRecruit'), c('k2', 'frostRecruit'), c('k3', 'frostRecruit')],
        board: [c('a1', 'bladeRecruit'), c('a2', 'frostRecruit')],
      },
    });
    const after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    expect(power(after, 'a1')).toBe(CARD_POOL['bladeRecruit']!.power + 1);
    expect(power(after, 'a2')).toBe(CARD_POOL['frostRecruit']!.power + 1);
  });
});

describe('星轨环：每回合第一次展示抽 1 张', () => {
  it('同一回合第二次展示不再抽', () => {
    const s = craft({
      zones: { spell: [c('o1', 'starOrbit')], cost: [c('k1', 'frostRecruit')] },
      deck: Array.from({ length: 10 }, () => 'frostRecruit'),
    });
    const first = apply(s, starRevealEvents(CTX.now, s, 'p1', 1, CTX).events);
    expect(first.players['p1']!.zones.hand.length).toBe(1);

    const second = apply(first, starRevealEvents(CTX.now, first, 'p1', 1, CTX).events);
    expect(second.players['p1']!.zones.hand.length).toBe(1); // 本回合额度已用
  });
});
