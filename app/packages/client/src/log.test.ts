import { describe, expect, it } from 'vitest';

import type { GameEvent, GameState } from '@app/shared/types';

import { describeEvent } from './log.js';

/**
 * 事件 → 中文日志（B2-5 右侧战报列）。
 *
 * ## 为什么值得测
 *
 * 这一层不影响任何结算，但**玩家理解对局的唯一通道**就是它：
 * 「谁破坏了谁」「谁抽到了什么」全靠日志。E2E 也在读这些文案
 * （`turn.spec.ts` 等 `完成换牌`），文案改字就会连带改测试。
 *
 * 另外这里有一批「**必须返回 null**」的条目（记账事件、展示中转位移），
 * 多写一行就是一次攻击刷 4 条记录 —— 那种「噪音」比缺行更容易漏。
 */

const NAMES = { p1: 'Era', p2: 'Guest' } as const;

const ev = (type: string, payload: Record<string, unknown> = {}): GameEvent => ({
  type,
  at: 1_000,
  payload,
});

/** 只带一张手牌的状态 —— 用于验证「按 uid 反查卡名」。 */
function stateWithCard(uid: string, defId: string): GameState {
  return stateWithHands({ p1: [{ uid, defId }] });
}

/**
 * 按「玩家 → 手牌列表」构造状态。
 *
 * 隐藏信息（#136）的用例必须把牌放到**对手**手里：卡只在自己手上时，
 * 「不打印卡名」会被 `defIdOf` 查不到这一层顺手满足，测试假绿。
 */
function stateWithHands(
  hands: Readonly<Record<string, { uid: string; defId: string }[]>>,
): GameState {
  const seats = Object.keys(hands);
  const players: Record<string, unknown> = {};
  for (const id of seats) {
    players[id] = {
      id,
      zones: {
        deck: [],
        hand: hands[id],
        commander: [],
        board: [],
        spell: [],
        cost: [],
        graveyard: [],
        exile: [],
        reveal: [],
      },
    };
  }
  return { seats, players } as unknown as GameState;
}

describe('事件日志文案', () => {
  it('记账 / 中转事件不进日志（返回 null）', () => {
    expect(describeEvent(ev('rng:advance'), NAMES, null)).toBeNull();
    // 展示区是内部中转：进出都不写，玩家只看「展示：X」那一行
    expect(describeEvent(ev('card:moved', { to: 'reveal', uid: 'u1' }), NAMES, null)).toBeNull();
    expect(describeEvent(ev('card:moved', { from: 'reveal', uid: 'u1' }), NAMES, null)).toBeNull();
    expect(describeEvent(ev('deck:put-bottom'), NAMES, null)).toBeNull();
    // 选择的挂起/排队由浮层呈现，日志不需要
    expect(describeEvent(ev('choice:pending'), NAMES, null)).toBeNull();
  });

  it('抽牌 / 破坏 / 出牌用卡名而不是 defId', () => {
    const s = stateWithCard('u1', 'bladeScout');
    // 第 4 参是**视角玩家**（#136）—— 自己的抽牌才显示卡名，故必须显式传 'p1'，
    // 不能靠默认值蒙对（默认值走的是 fail-closed 的「看不到对手手牌」分支）。
    expect(
      describeEvent(
        ev('card:moved', { from: 'deck', to: 'hand', uid: 'u1', playerId: 'p1' }),
        NAMES,
        s,
        'p1',
      ),
    ).toBe('Era 抽到 炎刃斥候');
    expect(describeEvent(ev('card:moved', { from: 'board', to: 'graveyard', uid: 'u1' }), NAMES, s)).toBe(
      '炎刃斥候 被破坏',
    );
  });

  it('查不到卡 / 玩家时退回 defId 与短 id，不出现空白', () => {
    expect(describeEvent(ev('card:moved', { to: 'cost', uid: 'u9' }), NAMES, null)).toBe(
      '— 置入费用区',
    );
    expect(describeEvent(ev('deck:shuffled', { playerId: 'p3-unknown' }), NAMES, null)).toBe(
      'p3-unk 洗牌',
    );
  });

  it('换牌 / 裁决 / 结束这些「玩家会截图」的行保持固定措辞', () => {
    expect(describeEvent(ev('mulligan:done', { playerId: 'p1' }), NAMES, null)).toBe('Era 完成换牌');
    expect(
      describeEvent(ev('combat:resolved', { atkPower: 2, defPower: 1, outcome: 'defender' }), NAMES, null),
    ).toBe('裁决 2 vs 1 → 防守方破坏');
    expect(describeEvent(ev('game:ended', { winner: 'p2' }), NAMES, null)).toBe(
      '对局结束，胜者：Guest',
    );
    // D-237 之后 40 轮不再判和，但旧回放仍可能带空 winner
    expect(describeEvent(ev('game:ended', { winner: '' }), NAMES, null)).toContain('平局');
  });

  it('未知事件类型回落成类型名（不吞事件，便于排查新事件漏翻译）', () => {
    expect(describeEvent(ev('some:new-event'), NAMES, null)).toBe('some:new-event');
  });

  /* ---- D-257 / D-258：新增事件必须有中文，且不能退化成英文标识符 ---- */

  it('顶替：说明「被顶替」而不是「被破坏」（顶替不是战斗结果）', () => {
    const s = stateWithCard('u1', 'bladeScout');
    const line = describeEvent(ev('unit:replaced', { slot: 1, byUid: 'u1', uid: 'u2' }), NAMES, s);
    expect(line).toContain('顶替');
    expect(line).toContain('炎刃斥候');
    expect(line).toContain('弃牌区');
    // 第 2 格（slot 1）要说成「第 2 格」，不能直接印 0 基下标
    expect(line).toContain('第 2 格');
  });

  it('顶替产生的离场位移不额外印「被破坏」', () => {
    expect(
      describeEvent(ev('card:moved', { from: 'board', to: 'graveyard', uid: 'u1', replaced: true }), NAMES, null),
    ).toBeNull();
  });

  it('自动充能用独立一行说清「+N 张」，与手动充能区分', () => {
    const line = describeEvent(ev('cost:income', { playerId: 'p1', amount: 2 }), NAMES, null);
    expect(line).toContain('2');
    expect(line).toContain('充能');
    expect(line).toContain('Era');
  });

  /* ---- D-263：卡组抽空把弃牌区洗回来（issue #91）---- */

  it('洗回说清「弃牌区 N 张回到卡组」，与常规洗牌区分', () => {
    const line = describeEvent(
      ev('deck:shuffled', { playerId: 'p1', order: ['a', 'b', 'c'], reason: 'reshuffle' }),
      NAMES,
      null,
    );
    expect(line).toBe('Era 把弃牌区 3 张洗回卡组');
    // 常规洗牌（开局 / 换牌洗回）不能被说成「弃牌区洗回」—— 那时没有弃牌区参与
    expect(describeEvent(ev('deck:shuffled', { playerId: 'p1', order: ['a', 'b'] }), NAMES, null)).toBe(
      'Era 洗牌',
    );
  });

  it('洗回时逐张的 graveyard→deck 位移不进日志（上面那条已汇总，否则刷 N 行）', () => {
    expect(
      describeEvent(ev('card:moved', { from: 'graveyard', to: 'deck', uid: 'u1', playerId: 'p1' }), NAMES, null),
    ).toBeNull();
    // 但「弃牌区 → 手牌」这类真实位移仍然要印（不能顺手把整类过滤掉）
    expect(
      describeEvent(ev('card:moved', { from: 'graveyard', to: 'hand', uid: 'u1' }), NAMES, null),
    ).toContain('→');
  });
});

/**
 * #136（Era 2026-10-22 拍板「对手只记『抽了 1 张』」）：**抽牌是私有信息**。
 *
 * 桌面上的对手手牌区只有「对方手牌 N 张」，战报却在逐张念卡名 ——
 * 同一份信息一半隐藏一半公开，玩家没法判断哪条规则是真的。
 *
 * 这里的用例是**一对不变量**：
 *  ① 私有流向按视角分叉（自己念卡名、对手只念张数、未知视角按对手处理）；
 *  ② 公开区（打出 / 展示 / 被破坏 / 手牌与场上 → 费用区）**不受影响** ——
 *     只藏私有流向，不是把对手整段静音。
 *
 * 「只藏私有流向」很容易被顺手写成「对手的事件都不念卡名」，那样会把战斗战报也毁掉，
 * 所以 ② 那几条和 ① 一样必须钉死。
 *
 * ## 两条子项共用一个 `viewer` 参数
 *
 * issue #136 的拍板（Era 2026-10-21 23:47「充能那一行请一并收口」）要求把两个
 * **同源**漏洞一起修：`deck → hand`（抽牌）与 `deck → cost`（充能）都是
 * 「牌库顶 → 一个不该公开的区」。做成两条子项、共用第 4 参 `viewer`，
 * 是为了「最小改动、可单独回滚」——任何一条出问题都能单独退回去，不会连带另一条。
 */
describe('隐藏信息：抽牌只看自己的卡名，对手只记张数', () => {
  /** 双方各一张手牌 —— 对手手里那张是「霜律终裁」（信息量极大的招牌技，正是 #136 的痛点）。 */
  const foeState = (): GameState =>
    stateWithHands({
      p1: [{ uid: 'u1', defId: 'bladeScout' }],
      p2: [{ uid: 'u2', defId: 'frostFinalJudgment' }],
    });

  const FOE_DRAWS = { from: 'deck', to: 'hand', uid: 'u2', playerId: 'p2' };

  it('自己抽牌仍然显示卡名', () => {
    const line = describeEvent(
      ev('card:moved', { from: 'deck', to: 'hand', uid: 'u1', playerId: 'p1' }),
      NAMES,
      foeState(),
      'p1',
    );
    expect(line).toBe('Era 抽到 炎刃斥候');
  });

  it('对手抽牌只记「抽了 1 张」，不再念卡名', () => {
    const line = describeEvent(ev('card:moved', FOE_DRAWS), NAMES, foeState(), 'p1');
    expect(line).toBe('Guest 抽了 1 张');
    // 显式否认卡名 —— 只断言整行等值，将来有人把卡名拼回去时仍能被这条抓住
    expect(line).not.toContain('霜律终裁');
  });

  it('不知道视角时按「看不到对手手牌」处理（fail-closed，不传第 4 参）', () => {
    // 新增调用点忘记传 viewer 时，宁可少显示，也不能泄露对手手牌
    const line = describeEvent(ev('card:moved', FOE_DRAWS), NAMES, foeState());
    expect(line).toBe('Guest 抽了 1 张');
    expect(line).not.toContain('霜律终裁');
  });

  it('对手打出（手牌 → 场面）仍然念卡名 —— 公开区不变', () => {
    const line = describeEvent(
      ev('card:moved', { from: 'hand', to: 'board', uid: 'u2', playerId: 'p2' }),
      NAMES,
      foeState(),
      'p1',
    );
    expect(line).toContain('霜律终裁');
  });

  it('对手展示仍然念卡名 —— card:revealed 是「本来就要给所有人看」的', () => {
    const line = describeEvent(
      ev('card:revealed', { uid: 'u2', playerId: 'p2' }),
      NAMES,
      foeState(),
      'p1',
    );
    expect(line).toBe('展示：霜律终裁');
  });

  it('对手随从被破坏仍然念卡名 —— 进弃牌区是公开信息', () => {
    const line = describeEvent(
      ev('card:moved', { from: 'board', to: 'graveyard', uid: 'u2', playerId: 'p2' }),
      NAMES,
      foeState(),
      'p1',
    );
    expect(line).toBe('霜律终裁 被破坏');
  });

  /* ---- 充能：与抽牌**同一个**隐藏信息漏洞（issue #136 评论 / Era 2026-10-21 23:47
   *      「充能那一行请一并收口」）—— 两者都是「牌库顶 → 私有区」，只修抽牌会留下同款。 ---- */

  it('自己充能（牌库顶 → 费用区）仍显示卡名 —— 原文案不变', () => {
    // 自己的文案一个字都不改：E2E 与玩家的肌肉记忆都依赖「X 置入费用区」
    const line = describeEvent(
      ev('card:moved', { from: 'deck', to: 'cost', uid: 'u1', playerId: 'p1' }),
      NAMES,
      foeState(),
      'p1',
    );
    expect(line).toBe('炎刃斥候 置入费用区');
  });

  it('对手充能只记「充能 1 张」，不再念卡名', () => {
    const line = describeEvent(
      ev('card:moved', { from: 'deck', to: 'cost', uid: 'u2', playerId: 'p2' }),
      NAMES,
      foeState(),
      'p1',
    );
    expect(line).toBe('Guest 充能 1 张');
    // 显式否认卡名 —— 将来有人把卡名拼回去时仍能被这条抓住
    expect(line).not.toContain('霜律终裁');
  });

  it('不知道视角时对手充能同样不念卡名（fail-closed，不传第 4 参）', () => {
    const s = foeState();
    /*
     * 先证明 `defIdOf` 在**这个状态**上确实查得到对手那张「霜律终裁」——
     * 否则下面的「不含卡名」会被「查不到卡名」顺手满足，测试假绿。
     * 展示行是现成的探针：它和充能行走的是同一个 `defIdOf`。
     */
    expect(describeEvent(ev('card:revealed', { uid: 'u2', playerId: 'p2' }), NAMES, s, 'p1')).toBe(
      '展示：霜律终裁',
    );
    const line = describeEvent(ev('card:moved', { from: 'deck', to: 'cost', uid: 'u2', playerId: 'p2' }), NAMES, s);
    expect(line).toBe('Guest 充能 1 张');
    expect(line).not.toContain('霜律终裁');
  });

  it('回归护栏：对手从手牌 / 场上充能仍念卡名 —— 隐藏范围止于「牌库顶」', () => {
    /*
     * ⚠️ 这条和上面三条一样重要。
     *
     * 收口很容易被顺手写成「对手所有进费用区的都不念卡名」，那样会误伤两类**公开**动作：
     *  - 手牌 → 费用区：玩家**主动**把这张牌置入费用区，属 Era 表格里的「离手即公开」；
     *  - 场上 → 费用区：随从本来就在桌面上摊着，卡名从来不是秘密。
     * 只有「牌库顶 → 费用区」是隐藏信息（抽牌的同款漏洞），所以判定条件必须带上 `from === 'deck'`。
     */
    const s = foeState();
    expect(
      describeEvent(ev('card:moved', { from: 'hand', to: 'cost', uid: 'u2', playerId: 'p2' }), NAMES, s, 'p1'),
    ).toBe('霜律终裁 置入费用区');
    expect(
      describeEvent(ev('card:moved', { from: 'board', to: 'cost', uid: 'u2', playerId: 'p2' }), NAMES, s, 'p1'),
    ).toBe('霜律终裁 置入费用区');
  });
});
