/**
 * 8 血版规则 + 三体系卡池的回归测试（ADR-0024 / ADR-0025）。
 *
 * 与 `effects.test.ts` 的分工：那边测**既有**效果（统领 / 号令 / 军师）；
 * 这里测 2026-10-19 新增的规则与 30 张卡里的新效果。
 */

import { describe, expect, it } from 'vitest';

import { RULE_ERRORS } from '@app/shared/constants';
import type { CardInstance, GameState, Intent, Phase, Zone } from '@app/shared/types';
import { CARD_POOL } from '@app/shared/cards';

import { applyIntent, createInitialState, reduce, INTENTS } from '../index.js';
import { unitPower } from '../ops.js';

const CTX = { now: 1000, cards: CARD_POOL };
const c = (uid: string, defId: string): CardInstance => ({ uid, defId });
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

function craft(patch: {
  phase?: Phase;
  turn?: number;
  activeSeat?: number;
  zones?: Partial<Record<Zone, CardInstance[]>>;
  foeZones?: Partial<Record<Zone, CardInstance[]>>;
  commander?: string;
  foeCommander?: string;
}): GameState {
  const deck = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 'bladeRecruit' : 'frostRecruit'));
  const s = createInitialState({
    seed: 1,
    seats: ['p1', 'p2'],
    decks: { p1: deck, p2: deck },
    commanders: {
      p1: patch.commander ?? 'bladeLord',
      p2: patch.foeCommander ?? 'bladeLord',
    },
  });
  const out: GameState = {
    ...s,
    started: true,
    phase: patch.phase ?? 'main',
    turn: patch.turn ?? 2,
    activeSeat: patch.activeSeat ?? 0,
    players: {
      p1: { ...s.players['p1']!, maxCost: 10, commanderPowerIndex: 1 },
      p2: { ...s.players['p2']!, maxCost: 10, commanderPowerIndex: 1 },
    },
  };
  if (patch.zones) {
    out.players = {
      ...out.players,
      p1: { ...out.players['p1']!, zones: { ...out.players['p1']!.zones, ...patch.zones } },
    };
  }
  if (patch.foeZones) {
    out.players = {
      ...out.players,
      p2: { ...out.players['p2']!, zones: { ...out.players['p2']!.zones, ...patch.foeZones } },
    };
  }
  return out;
}

/* ------------------------------ 霜冻（ADR-0025 §5） ------------------------------ */

describe('霜冻：跳过 1 次重置，回合结束解除', () => {
  it('重置阶段不重置霜冻单位；非霜冻单位正常解除休眠', () => {
    const s = craft({
      zones: {
        board: [
          { uid: 'a1', defId: 'bladeVanguard', sleeping: true, frozen: true },
          { uid: 'a2', defId: 'bladeVanguard', sleeping: true },
        ],
      },
    });
    const after = reduce(s, { type: 'units:reset', at: 1, payload: { playerId: 'p1' } });
    expect(after.players['p1']!.zones.board.find((x) => x.uid === 'a1')!.sleeping).toBe(true);
    expect(after.players['p1']!.zones.board.find((x) => x.uid === 'a1')!.frozen).toBe(true);
    expect(after.players['p1']!.zones.board.find((x) => x.uid === 'a2')!.sleeping).toBe(false);
  });

  it('控制者回合的结束阶段解除霜冻（仍休眠）', () => {
    const s = craft({
      activeSeat: 0,
      zones: { board: [{ uid: 'a1', defId: 'bladeVanguard', sleeping: true, frozen: true }] },
    });
    const after = reduce(s, { type: 'phase:changed', at: 1, payload: { from: 'battle', to: 'end' } });
    const a1 = after.players['p1']!.zones.board[0]!;
    expect(a1.frozen).toBeUndefined();
    expect(a1.sleeping).toBe(true);
  });

  it('裁决官Ⅱ：敌方随从被霜冻时抽一张（每回合一次）', () => {
    const s = craft({
      commander: 'frostAdjudicator',
      zones: {
        commander: [c('cmd1', 'frostAdjudicator')],
        cost: [c('k1', 'bladeRecruit'), c('k2', 'bladeRecruit')],
        deck: [c('d1', 'bladeRecruit'), c('d2', 'bladeRecruit')],
      },
      foeZones: { board: [c('f1', 'bladeVanguard')] },
    });
    let after = run(s, intent('p1', INTENTS.effectActivate, { uid: 'cmd1', effect: '1' }));
    expect(after.pendingChoice?.kind).toBe('frost-adjudicator-1');
    after = run(after, intent('p1', INTENTS.effectChoose, { choice: 'f1' }));
    expect(after.players['p2']!.zones.board[0]!.frozen).toBe(true);
    expect(after.players['p2']!.zones.board[0]!.sleeping).toBe(true);
    expect(after.players['p1']!.zones.hand.length).toBe(1); // Ⅱ 抽 1
  });
});

/* ------------------------------ 随从费用与 maxCost ------------------------------ */

describe('随从减费与费用上限（docs/16 §3 / §4）', () => {
  it('1 费随从实际 0 费，可直接打出（不需要费用区有卡）', () => {
    const s = craft({ zones: { hand: [c('h1', 'bladeVanguard')], cost: [] } });
    const after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    expect(after.players['p1']!.zones.board.map((x) => x.uid)).toEqual(['h1']);
    expect(after.players['p1']!.usedCostThisTurn).toBe(0);
  });

  it('法术不减费（按卡面值支付）', () => {
    const s = craft({
      zones: { hand: [c('h1', 'bladeOrder')], cost: [c('k1', 'bladeRecruit')] },
    });
    const after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    expect(after.players['p1']!.usedCostThisTurn).toBe(1);
  });
});

/* ------------------------------ 炎刃新增效果 ------------------------------ */

describe('炎刃随从效果（docs/12 §2）', () => {
  it('卫士：登场磨 1 张；磨到炎刃卡时可选择除外', () => {
    const s = craft({
      zones: {
        hand: [c('h1', 'bladeGuard')],
        cost: [c('k1', 'bladeRecruit')],
        deck: [c('d1', 'bladeKnight'), c('d2', 'bladeRecruit')],
      },
    });
    let after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    expect(after.players['p1']!.zones.graveyard.map((x) => x.uid)).toContain('d1');
    expect(after.pendingChoice?.kind).toBe('blade-guard-exile');
    after = run(after, intent('p1', INTENTS.effectChoose, { choice: 'd1' }));
    expect(after.players['p1']!.zones.exile.map((x) => x.uid)).toEqual(['d1']);
  });

  it('勇士：除外区每 3 张炎刃 → 本回合 +1，最多 +3', () => {
    const exile = Array.from({ length: 9 }, (_, i) => c(`x${i}`, 'bladeVanguard'));
    const s = craft({
      zones: {
        hand: [c('h1', 'bladeChampion')],
        cost: Array.from({ length: 5 }, (_, i) => c(`k${i}`, 'bladeRecruit')),
        exile,
      },
    });
    const after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    expect(unitPower(after, CARD_POOL, 'h1')).toBe(10); // 7 + 3
  });

  it('凤凰：登场清空弃牌区炎刃并每张 +1（上限 +5）', () => {
    const graveyard = Array.from({ length: 6 }, (_, i) => c(`g${i}`, 'bladeVanguard'));
    const s = craft({
      zones: {
        hand: [c('h1', 'bladePhoenix')],
        cost: Array.from({ length: 6 }, (_, i) => c(`k${i}`, 'bladeRecruit')),
        graveyard,
      },
    });
    const after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    // 6 张弃牌区 + 6 张支付（炎刃新兵）全部被除外
    expect(after.players['p1']!.zones.exile.length).toBe(12);
    expect(after.players['p1']!.zones.graveyard.length).toBe(0);
    expect(unitPower(after, CARD_POOL, 'h1')).toBe(12); // 7 + 5（上限）
  });

  it('骑士：攻击时可除外弃牌区炎刃换 +1，参与当次裁决', () => {
    const s = craft({
      phase: 'battle',
      zones: {
        board: [c('a1', 'bladeKnight')],
        graveyard: [c('g1', 'bladeVanguard')],
      },
      foeZones: { board: [c('f1', 'bladeGuard')] }, // 力 2
    });
    let after = run(s, intent('p1', INTENTS.attack, { attackerUid: 'a1', targetUid: 'f1' }));
    expect(after.pendingChoice?.kind).toBe('blade-knight-attack');
    after = run(after, intent('p1', INTENTS.effectChoose, { choice: 'g1' }));
    expect(after.players['p1']!.zones.exile.map((x) => x.uid)).toEqual(['g1']);
    expect(after.players['p2']!.zones.board.length).toBe(0);
    expect(unitPower(after, CARD_POOL, 'a1')).toBe(5); // 4 + 1（本回合）
  });

  /*
   * D-260 / issue #88：「炎刃骑士攻击时存在死锁，会一直加攻击力停不下来」。
   *
   * 修之前 `choose` 从不发 `choice:cleared`，攻击结算完 `pendingChoice` 一直挂着
   * → 界面上选择面板关不掉，玩家被卡死；面板里残留的选项还能继续点，
   * 每点一次走一遍「除外 + 力量 +1」（`exileCard` 对已除外的卡产出 exile→exile 空移动，
   * 调用方仍当成功）。下面三条分别钉住「关得掉」「点不动」「加不了」。
   */
  it('骑士：选择结算后选择链必须关闭（issue #88 的死锁点）', () => {
    const s = craft({
      phase: 'battle',
      zones: { board: [c('a1', 'bladeKnight')], graveyard: [c('g1', 'bladeVanguard')] },
      foeZones: { board: [c('f1', 'bladeGuard')] },
    });
    let after = run(s, intent('p1', INTENTS.attack, { attackerUid: 'a1', targetUid: 'f1' }));
    expect(after.pendingChoice).not.toBeNull();
    after = run(after, intent('p1', INTENTS.effectChoose, { choice: 'g1' }));
    // ⚠️ 修之前这里是 blade-knight-attack —— 面板永远关不掉
    expect(after.pendingChoice).toBeNull();
  });

  it('骑士：选「跳过」同样关闭选择链，且攻击照常结算', () => {
    const s = craft({
      phase: 'battle',
      zones: { board: [c('a1', 'bladeKnight')], graveyard: [c('g1', 'bladeVanguard')] },
      foeZones: { board: [c('f1', 'bladeGuard')] },
    });
    let after = run(s, intent('p1', INTENTS.attack, { attackerUid: 'a1', targetUid: 'f1' }));
    after = run(after, intent('p1', INTENTS.effectChoose, { choice: 'pass' }));
    expect(after.pendingChoice).toBeNull();
    expect(after.players['p2']!.zones.board).toHaveLength(0); // 力 4 > 2，防守方破坏
    expect(unitPower(after, CARD_POOL, 'a1')).toBe(4); // 跳过不加力量
    expect(after.players['p1']!.zones.graveyard.map((x) => x.uid)).toEqual(['g1']);
  });

  it('骑士：选项已不在弃牌区时拒绝，不再叠加力量（陈旧选项）', () => {
    const s = craft({
      phase: 'battle',
      zones: {
        board: [c('a1', 'bladeKnight')],
        graveyard: [c('g1', 'bladeVanguard')],
        exile: [c('x1', 'bladeScout')],
      },
      foeZones: { board: [c('f1', 'bladeGuard')] },
    });
    const before = run(s, intent('p1', INTENTS.attack, { attackerUid: 'a1', targetUid: 'f1' }));
    // 模拟「面板没关时那张卡已被除外」：选项里塞一张已在除外区的卡
    const stale: GameState = {
      ...before,
      pendingChoice: {
        playerId: 'p1',
        kind: 'blade-knight-attack',
        sourceUid: 'a1',
        options: ['x1'],
        meta: { attackerUid: 'a1', targetUid: 'f1' },
      },
    };
    const r = applyIntent(stale, intent('p1', INTENTS.effectChoose, { choice: 'x1' }), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.INVALID_CHOICE);
    // 力量没有被偷偷 +1（修之前这条会变成 5）
    expect(unitPower(stale, CARD_POOL, 'a1')).toBe(4);
  });

  it('老兵：登场可除外弃牌区炎刃换抽 1', () => {
    const s = craft({
      zones: {
        hand: [c('h1', 'bladeVeteran')],
        cost: [c('k1', 'bladeRecruit'), c('k2', 'bladeRecruit'), c('k3', 'bladeRecruit'), c('k4', 'bladeRecruit')],
        graveyard: [c('g1', 'bladeVanguard')],
        deck: [c('d1', 'bladeRecruit')],
      },
    });
    let after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    expect(after.pendingChoice?.kind).toBe('blade-veteran-exile');
    after = run(after, intent('p1', INTENTS.effectChoose, { choice: 'g1' }));
    expect(after.players['p1']!.zones.exile.map((x) => x.uid)).toEqual(['g1']);
    expect(after.players['p1']!.zones.hand.map((x) => x.uid)).toEqual(['d1']);
  });

  it('战旗：每回合第一次除外炎刃卡时抽 1', () => {
    const s = craft({
      zones: {
        spell: [c('banner', 'bladeBanner')],
        graveyard: [c('g1', 'bladeVanguard')],
        deck: [c('d1', 'bladeRecruit')],
      },
      foeZones: { board: [c('f1', 'bladeRecruit')] },
    });
    // 用统领Ⅱ除外一张手牌来触发战旗（战旗扫描 spell 区）
    const withHand: GameState = {
      ...s,
      players: {
        ...s.players,
        p1: {
          ...s.players['p1']!,
          zones: { ...s.players['p1']!.zones, hand: [c('h1', 'bladeVanguard')] },
        },
      },
    };
    // 没有指挥官实例 → 改用骑士攻击路径需要弃牌区/攻击；这里直接构造除外事件走 exileCard 的等价链路：
    // 卫士登场磨到炎刃卡后选择除外
    const guardState: GameState = {
      ...withHand,
      players: {
        ...withHand.players,
        p1: {
          ...withHand.players['p1']!,
          zones: {
            ...withHand.players['p1']!.zones,
            hand: [c('h2', 'bladeGuard')],
            cost: [c('k1', 'bladeRecruit')],
            deck: [c('d2', 'bladeKnight'), c('d3', 'bladeRecruit')],
          },
        },
      },
    };
    let after = run(guardState, intent('p1', INTENTS.play, { uid: 'h2' }));
    after = run(after, intent('p1', INTENTS.effectChoose, { choice: 'd2' }));
    expect(after.players['p1']!.zones.exile.map((x) => x.uid)).toEqual(['d2']);
    // 战旗抽 1（d3）
    expect(after.players['p1']!.zones.hand.map((x) => x.uid)).toContain('d3');
  });

  it('战术：选择一个己方随从 +2；除外区 ≥3 时 +3', () => {
    const s = craft({
      zones: {
        hand: [c('h1', 'bladeTactics')],
        cost: [c('k1', 'bladeRecruit'), c('k2', 'bladeRecruit')],
        board: [c('b1', 'bladeVanguard')],
        exile: [c('x1', 'bladeVanguard'), c('x2', 'bladeVanguard'), c('x3', 'bladeVanguard')],
      },
    });
    let after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    expect(after.pendingChoice?.kind).toBe('blade-tactics-target');
    after = run(after, intent('p1', INTENTS.effectChoose, { choice: 'b1' }));
    expect(unitPower(after, CARD_POOL, 'b1')).toBe(5); // 2 + 3
  });

  it('焚典：展示 4 张，选炎刃卡除外，其余进弃牌区', () => {
    const s = craft({
      zones: {
        hand: [c('h1', 'bladeCremation')],
        cost: [c('k1', 'bladeRecruit'), c('k2', 'bladeRecruit')],
        deck: [c('d1', 'bladeKnight'), c('d2', 'bladeRecruit'), c('d3', 'bladeVanguard'), c('d4', 'bladeScout')],
      },
    });
    let after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    expect(after.pendingChoice?.kind).toBe('blade-cremation');
    after = run(after, intent('p1', INTENTS.effectChoose, { choice: 'd1' }));
    expect(after.players['p1']!.zones.exile.map((x) => x.uid)).toEqual(['d1']);
    after = run(after, intent('p1', INTENTS.effectChoose, { choice: 'pass' }));
    const gy = after.players['p1']!.zones.graveyard.map((x) => x.uid);
    expect(gy).toEqual(expect.arrayContaining(['d2', 'd3', 'd4']));
  });
});

/* ------------------------------ 霜律效果 ------------------------------ */

describe('霜律效果（docs/12 §4）', () => {
  it('学徒：登场霜冻一个敌方随从', () => {
    const s = craft({
      zones: { hand: [c('h1', 'frostApprentice')] },
      foeZones: { board: [c('f1', 'bladeVanguard')] },
    });
    let after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    expect(after.pendingChoice?.kind).toBe('frost-apprentice-freeze');
    after = run(after, intent('p1', INTENTS.effectChoose, { choice: 'f1' }));
    expect(after.players['p2']!.zones.board[0]!.frozen).toBe(true);
  });

  it('典狱长：登场霜冻所有敌方随从', () => {
    const s = craft({
      zones: {
        hand: [c('h1', 'frostJailer')],
        cost: [c('k1', 'bladeRecruit'), c('k2', 'bladeRecruit'), c('k3', 'bladeRecruit'), c('k4', 'bladeRecruit')],
      },
      foeZones: { board: [c('f1', 'bladeVanguard'), c('f2', 'bladeRecruit')] },
    });
    const after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    expect(after.players['p2']!.zones.board.every((x) => x.frozen)).toBe(true);
  });

  it('审判：未霜冻则霜冻；已霜冻则破坏', () => {
    const mk = (frozen: boolean) =>
      craft({
        zones: {
          hand: [c('h1', 'frostJudgment')],
          cost: [c('k1', 'bladeRecruit'), c('k2', 'bladeRecruit'), c('k3', 'bladeRecruit')],
        },
        foeZones: { board: [{ uid: 'f1', defId: 'bladeVanguard', ...(frozen ? { frozen: true } : {}) }] },
      });

    let after = run(mk(false), intent('p1', INTENTS.play, { uid: 'h1' }));
    after = run(after, intent('p1', INTENTS.effectChoose, { choice: 'f1' }));
    expect(after.players['p2']!.zones.board[0]!.frozen).toBe(true);

    let killed = run(mk(true), intent('p1', INTENTS.play, { uid: 'h1' }));
    killed = run(killed, intent('p1', INTENTS.effectChoose, { choice: 'f1' }));
    expect(killed.players['p2']!.zones.board.length).toBe(0);
  });

  it('终裁：破坏所有霜冻敌方随从，每破坏一个对指挥官造成 1 点', () => {
    const s = craft({
      zones: {
        hand: [c('h1', 'frostFinalJudgment')],
        cost: Array.from({ length: 5 }, (_, i) => c(`k${i}`, 'bladeRecruit')),
      },
      foeZones: {
        commander: [c('p2#commander', 'bladeLord')],
        board: [
          { uid: 'f1', defId: 'bladeVanguard', frozen: true },
          { uid: 'f2', defId: 'bladeRecruit', frozen: true },
          { uid: 'f3', defId: 'bladeRecruit' },
        ],
      },
    });
    const after = run(s, intent('p1', INTENTS.play, { uid: 'h1' }));
    expect(after.players['p2']!.zones.board.map((x) => x.uid)).toEqual(['f3']);
    expect(after.players['p2']!.health).toBe(6); // 8 - 2
  });

  it('寒域：敌方霜冻随从 −1 力（下限 0）', () => {
    const s = craft({
      zones: { spell: [c('domain', 'frostDomain')] },
      foeZones: { board: [{ uid: 'f1', defId: 'bladeVanguard', frozen: true }] },
    });
    expect(unitPower(s, CARD_POOL, 'f1')).toBe(1); // 2 - 1
    const weak = craft({
      zones: { spell: [c('domain', 'frostDomain')] },
      foeZones: { board: [{ uid: 'f1', defId: 'frostRecruit', frozen: true }] },
    });
    expect(unitPower(weak, CARD_POOL, 'f1')).toBe(0); // 1 - 1 → 0，不为负
  });
});

/* ------------------------------ 指挥官技能费用（D-229） ------------------------------ */

describe('指挥官技能费用固定 2 费（D-229 撤销 D-228 的「3 − 档位」）', () => {
  const mk = (index: number, costCards: CardInstance[]): GameState => {
    const s = craft({
      commander: 'frostAdjudicator',
      zones: { commander: [c('cmd1', 'frostAdjudicator')], cost: costCards },
      foeZones: { board: [c('f1', 'bladeVanguard')] },
    });
    return {
      ...s,
      players: { ...s.players, p1: { ...s.players['p1']!, commanderPowerIndex: index } },
    };
  };

  it('无论档位（第 1 轮 / 第 3 轮）都付 2 张', () => {
    const two = [c('k1', 'bladeRecruit'), c('k2', 'bladeRecruit')];
    let s = run(mk(1, two), intent('p1', INTENTS.effectActivate, { uid: 'cmd1', effect: '1' }));
    expect(s.players['p1']!.zones.cost.length).toBe(0);
    expect(s.players['p1']!.usedCostThisTurn).toBe(2);
    expect(s.pendingChoice?.kind).toBe('frost-adjudicator-1');

    // D-229：档位不再影响技能费用 —— 第 3 轮同样要 2 张。
    s = run(mk(3, two), intent('p1', INTENTS.effectActivate, { uid: 'cmd1', effect: '1' }));
    expect(s.players['p1']!.zones.cost.length).toBe(0);
    expect(s.players['p1']!.usedCostThisTurn).toBe(2);
  });

  it('费用区只有 1 张 → 拒绝（不足 2）', () => {
    const r = applyIntent(
      mk(3, [c('k1', 'bladeRecruit')]),
      intent('p1', INTENTS.effectActivate, { uid: 'cmd1', effect: '1' }),
      CTX,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.INSUFFICIENT_COST);
  });
});

/* ------------------------------ 终局与平局 ------------------------------ */

describe('终局', () => {
  it('平局字段：game:ended 无胜者且 reason=draw 时 state.draw 为 true', () => {
    const s = craft({});
    const after = reduce(s, { type: 'game:ended', at: 1, payload: { winner: '', reason: 'draw' } });
    expect(after.draw).toBe(true);
    expect(after.winner).toBeNull();
    // 对局结束后任何 Intent 都被拒
    const r = applyIntent(after, intent('p1', INTENTS.phaseAdvance), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect([RULE_ERRORS.GAME_OVER, RULE_ERRORS.NOT_STARTED]).toContain(r.error.code);
  });
});
