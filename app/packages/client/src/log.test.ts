import { describe, expect, it } from 'vitest';

import type { GameEvent, GameState } from '@app/shared/types';

import { LOG_LIMIT, describeEvent, pushLogLine, type LogEntry } from './log.js';

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

  /*
   * ⚠️ 本条**方向已反转**（#121 / D-291）。
   *
   * 旧口径是「未知事件回落成类型名，不吞事件，便于排查新事件漏翻译」——
   * 代价是玩家在中文战报里读到 `draw:completed`、`mulligan:closed`，
   * 第一反应是「报错了」。开发期的便利不该由玩家承担。
   *
   * 新口径：**未映射就隐藏**。排查靠服务端日志与回放（都是全量），不靠玩家战报。
   */
  it('未知事件类型不进日志（不再回落成类型名）', () => {
    expect(describeEvent(ev('some:new-event'), NAMES, null)).toBeNull();
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
 * ## 只有抽牌是隐藏的；充能不是（#143 纠正 #136）
 *
 * 这里曾经把 `deck → hand` 与 `deck → cost` 当成「同源漏洞」一起藏起来，
 * 依据写的是「Era 2026-10-21 23:47『充能那一行请一并收口』」—— **那句话不存在**。
 * 事实是：Era 批的只有抽牌；把充能一起收口是**我（Penquill）自己在 #136 评论里加的**，
 * 还写进了以「拍板结果」开头的表里，属伪造决策归属（与 D-283 同类）。
 *
 * Era 2026-10-22 拍板的信息可见性口径（`docs/16 §7.5` C-06）是「**只看牌在哪个区**」：
 *  - 隐藏区（手牌 / 牌库）→ 对手连牌名都不可见；
 *  - 公开区（场上 / **费用区** / 弃牌区 / 除外区 / 指挥官区 / 展示区）→ 对手可见牌名。
 *
 * `deck → cost` 的终点是**费用区**，所以对手看得见是哪张牌。本组用例因此断言：
 *  ① `deck → hand` 按视角分叉（自己念卡名、对手只念张数、未知视角按对手处理）；
 *  ② `deck → cost` **不分叉**，双方都念卡名；
 *  ③ 其余公开位移不受影响（打出 / 展示 / 被破坏 / 手牌与场上 → 费用区）。
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

  /* ---- 充能：终点是**公开区**，念卡名（#143 纠正 #136 的过度收口）。
   *     曾经把 `deck → cost` 也当成「牌库顶 → 私有区」，那是错的 —— 见本组开头的说明。 ---- */

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

  it('对手充能（牌库顶 → 费用区）**念卡名** —— 终点是公开区（#143）', () => {
    const line = describeEvent(
      ev('card:moved', { from: 'deck', to: 'cost', uid: 'u2', playerId: 'p2' }),
      NAMES,
      foeState(),
      'p1',
    );
    // 卡名必须出现；归属要带前缀，否则双方共用一列战报时分不清是谁充的
    expect(line).toBe('Guest 将 霜律终裁 置入费用区');
  });

  it('不知道视角时对手充能仍念卡名 —— 公开区与视角无关（不传第 4 参）', () => {
    /*
     * fail-closed 只对**隐藏区流向**成立（怕泄露手牌）；费用区是公开区，
     * 少传视角不该让公开信息凭空消失，否则新增调用点一漏就是「战报比桌面更封闭」。
     */
    const line = describeEvent(
      ev('card:moved', { from: 'deck', to: 'cost', uid: 'u2', playerId: 'p2' }),
      NAMES,
      foeState(),
    );
    expect(line).toBe('Guest 将 霜律终裁 置入费用区');
  });

  it('对手把牌塞回牌库（手牌 → 卡组）不念卡名 —— 两端都是隐藏区', () => {
    const line = describeEvent(
      ev('card:moved', { from: 'hand', to: 'deck', uid: 'u2', playerId: 'p2' }),
      NAMES,
      foeState(),
      'p1',
    );
    expect(line).not.toContain('霜律终裁');
    expect(line).toContain('1 张');
  });

  it('回归护栏：对手从手牌 / 场上充能仍念卡名 —— 隐藏范围止于「牌库顶」', () => {
    /*
     * ⚠️ 这条和上面三条一样重要。
     *
     * 收口很容易被顺手写成「对手所有进费用区的都不念卡名」，那样会误伤两类**公开**动作：
     *  - 手牌 → 费用区：玩家**主动**把这张牌置入费用区，属 Era 表格里的「离手即公开」；
     *  - 场上 → 费用区：随从本来就在桌面上摊着，卡名从来不是秘密。
     * 现在改成**按区域查表**（§7.5）：终点是费用区就念卡名，与 `from` 无关 ——
     * 这一条守的就是「不要因为改表而把公开位移也一起静音」。
     */
    const s = foeState();
    expect(
      describeEvent(ev('card:moved', { from: 'hand', to: 'cost', uid: 'u2', playerId: 'p2' }), NAMES, s, 'p1'),
    ).toBe('Guest 将 霜律终裁 置入费用区');
    expect(
      describeEvent(ev('card:moved', { from: 'board', to: 'cost', uid: 'u2', playerId: 'p2' }), NAMES, s, 'p1'),
    ).toBe('Guest 将 霜律终裁 置入费用区');
  });
});

/* -------------------- #121：战报里不许出现协议串 -------------------- */

/**
 * 打脸不是「裁决」（#156）。
 *
 * `attack.ts` 对「随从攻击敌方指挥官」硬编码 `outcome: 'defender'` + `defPower: 0`，
 * 照字面渲染就是「裁决 5 vs 0 → 防守方破坏」—— 而打脸什么都不破坏，
 * 且这是每回合都会出现的最频繁路径。文案层负责把这条岔开：
 * 裁决行不出，改由「谁直击了指挥官、掉了多少」说清。
 */
describe('打脸的战报（#156）', () => {
  /** 状态里放一张敌方指挥官 + 一张我方场上随从，供 `defIdOf` 反查。 */
  function stateWithCommander(): GameState {
    const s = stateWithHands({ p1: [], p2: [] });
    const players = (s as unknown as {
      players: Record<string, { zones: Record<string, { uid: string; defId: string }[]> }>;
    }).players;
    players.p2!.zones.commander = [{ uid: 'c2', defId: 'bladeLord' }];
    players.p1!.zones.board = [{ uid: 'a1', defId: 'bladeKnight' }];
    players.p1!.zones.commander = [{ uid: 'c1', defId: 'frostAdjudicator' }];
    return s;
  }

  it('打指挥官不写「裁决 X vs 0 → 防守方破坏」', () => {
    const s = stateWithCommander();
    expect(
      describeEvent(
        ev('combat:resolved', {
          by: 'p1',
          attackerUid: 'a1',
          targetUid: 'c2',
          atkPower: 5,
          defPower: 0,
          outcome: 'defender',
        }),
        NAMES,
        s,
      ),
      '打脸不发裁决行 —— 那句话在说「有东西被破坏」，而什么都没坏',
    ).toBeNull();
  });

  it('打随从仍然要裁决行（不能顺手删掉真对撞）', () => {
    const s = stateWithCommander();
    // 目标是我方场上那张随从（不是指挥官）→ 裁决行照旧
    expect(
      describeEvent(
        ev('combat:resolved', {
          by: 'p1',
          attackerUid: 'a1',
          targetUid: 'a1',
          atkPower: 4,
          defPower: 2,
          outcome: 'defender',
        }),
        NAMES,
        s,
      ),
    ).toBe('裁决 4 vs 2 → 防守方破坏');
  });

  it('指挥官受伤时写出「谁打的」与伤害值', () => {
    const s = stateWithCommander();
    expect(
      describeEvent(ev('commander:damaged', { playerId: 'p2', amount: 2, sourceUid: 'a1' }), NAMES, s),
    ).toBe('炎刃骑士 直击指挥官 → 造成 2 点伤害');
    // 查不到来源卡（旧回放 / 效果直伤）时退回不带主语的写法，不能出现「— 直击」
    expect(describeEvent(ev('commander:damaged', { playerId: 'p2', amount: 1 }), NAMES, s)).toBe(
      '指挥官受到 1 点伤害',
    );
  });

  it('「电脑的指挥官发起攻击」中间不留空格（#159-3）', () => {
    expect(describeEvent(ev('commander:attacked', { playerId: 'p1' }), NAMES, null)).toBe(
      'Era的指挥官发起攻击',
    );
  });
});

describe('未映射的事件不进玩家战报（issue #121 / D-291）', () => {
  /*
   * 症状：中文战报里蹦出 `draw:completed`、`mulligan:closed` 这类英文冒号串，
   * 玩家第一反应是「报错了」。根因是 `describeEvent` 的 `default` 直接 `return e.type`。
   *
   * 现在的口径：**未映射 → 不进日志**（回放/服务端日志仍是全量，docs/16 §7.5.4）。
   * 显式列出的这几个是有意忽略的中间事件，单独钉住，防止有人「顺手把它放回来」。
   */
  it('有意忽略的中间事件返回 null', () => {
    for (const type of [
      'draw:completed',
      'attack:declared',
      'trigger:attack',
      'trigger:defend',
      'card:pending-buff',
      'commander:grown',
    ]) {
      expect(describeEvent(ev(type), NAMES, null), type).toBeNull();
    }
  });

  it('换成中文而不是消失：换牌结束 / 即死模式', () => {
    // 这两条是里程碑，玩家需要知道；不写就等于「局面对不上」。
    expect(describeEvent(ev('mulligan:closed'), NAMES, null)).toBe('换牌结束，进入第一回合');
    const sudden = describeEvent(ev('sudden:death'), NAMES, null);
    expect(sudden).toContain('即死模式');
  });

  it('将来新增的未映射事件也不会把协议串漏到界面上', () => {
    // 这条是**方向性**断言：宁可少一行，也不许出现 `some:future-event`。
    const out = describeEvent(ev('some:future-event'), NAMES, null);
    expect(out).toBeNull();
    expect(out).not.toBe('some:future-event');
  });
});

/* -------------------- #135：战报的 key 必须唯一 -------------------- */

describe('战报行的 id 单调递增、不重复（issue #135 / D-291）', () => {
  /*
   * 旧实现：`{ id: prev.length + 1 }` 再 `.slice(-200)`。
   * 长度被钉在 200 之后，新行 id 恒为 201 —— React 报 key 冲突，
   * 行可能重复渲染或被吞，而战报是复盘的唯一凭据。
   *
   * 现在 `id` 由调用方的单调计数器给（`useRoom` 的 `logSeqRef`），
   * 这里直接测 `pushLogLine` 的性质，不需要渲染 React。
   */
  const push = (n: number): LogEntry[] => {
    let log: LogEntry[] = [];
    for (let i = 1; i <= n; i++) log = pushLogLine(log, 1000 + i, `第 ${i} 行`, i);
    return log;
  };

  it('连推 300 条后只留最近 200 条，且 id 两两不同', () => {
    const log = push(300);
    expect(log).toHaveLength(LOG_LIMIT);
    expect(log[log.length - 1]!.text).toBe('第 300 行');
    expect(log[0]!.text).toBe('第 101 行'); // 前 100 条被截掉
    const ids = log.map((x) => x.id);
    expect(new Set(ids).size).toBe(LOG_LIMIT);
    // 截断之后 id 仍应是连续递增的尾部，而不是「全 201」
    expect(ids).toEqual(Array.from({ length: LOG_LIMIT }, (_, i) => i + 101));
  });

  it('旧算法确实会撞 key（把根因钉成断言，防止改回去）', () => {
    // 复刻旧实现：id 取「当前长度 + 1」
    let old: { id: number }[] = [];
    for (let i = 0; i < 300; i++) old = [...old, { id: old.length + 1 }].slice(-LOG_LIMIT);
    /*
     * 截到 200 条之后长度恒为 200 → 新行 id 恒为 201。
     * 300 行里：前 100 行（1..200 那批剩下的）id 各异，后 100 行全是 201，
     * 于是只剩 101 个不同的 id —— 其中序号 201 重复了 100 次。
     */
    const ids = old.map((x) => x.id);
    expect(new Set(ids).size).toBe(101);
    expect(ids[ids.length - 1]).toBe(201);
    expect(ids.filter((x) => x === 201)).toHaveLength(100);
  });
});
