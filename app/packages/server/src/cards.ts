import { KEYWORD_TAUNT, type CardDef } from '@app/shared';

/**
 * 卡池（卡定义表）。
 *
 * ## 数据来源有两类，务必区分
 *
 * 1. **Era 提供** —— 首批卡牌样例 `ETCG=炎刃.docx`（2026-10-13，5 张）。
 *    转录原则见 **ADR-0015**：`cost` / `power` / `type` 照抄卡面，
 *    `text` 存卡面原文；**效果一律不执行**（`A7` 关键词表与触发时机均未给）。
 *    `damage` 不写 —— 样例卡面均未写伤害值，按 X-5 取 `DEFAULT_DAMAGE = 1`。
 *
 * 2. **我方补齐的占位卡** —— 见文件末尾 `PLACEHOLDER_CARD_IDS`（8 张）。
 *    Era 2026-10-13 授权生成，**只补数值、不写效果**，
 *    目的是让「组出 30 张合法主卡组」成立以跑通联机链路；
 *    正式卡表到位后**整批替换**。
 *
 * ⚠️ 卡组校验照旧严格（主卡组 30 + 指挥官 1），不因池有占位卡而放宽。
 */
export const CARD_POOL: Record<string, CardDef> = {
  bladeLord: {
    defId: 'bladeLord',
    name: '炎刃军统领',
    type: 'commander',
    /**
     * 指挥官不通过支付打出，而是开局揭示直接入指挥官区（X-1），故 `cost` 恒为 0。
     *
     * ⚠️ `power` 是**曲线**而非定值：卡面写「力量值 0-1-3-5 力量值提升，在每回合充能阶段执行」。
     * 此处仅记**初始档位的值 0**，完整曲线置于 `powerCurve`。
     *
     * 曲线语义（X-7 / ADR-0016，Era 2026-10-13「初始 0 然后每个充能阶段成长，
     * 第一回合就会变到 1」）：**档位序列**而非「回合号 → 力量值」映射 ——
     * 开局 0 → 第 1 回合充能后 1 → 第 2 回合后 3 → 第 3 回合后 5 → 之后封顶保持 5。
     */
    cost: 0,
    power: 0,
    text: [
      '力量值0-1-3-5 力量值提升，在每回合充能阶段执行',
      'Ⅰ 【2】每回合一次，可以根据除外区的卡名包含炎刃的卡的数量执行以下最多3个效果，每个效果最多一次：',
      '1个：从墓地选择一个力量值在除外区炎刃数量等级以下的随从，召唤',
      '3个：选择一个随从，本回合力量值+1',
      '5个：选择一个力量值在除外区炎刃数量等级以下的随从，破坏',
      '7个：选择一个随从，本回合对指挥官伤害+1',
      '9个：选择一个随从，本回合攻击后重置',
      'Ⅱ 每回合一次，可以将一张手牌除外。',
    ].join('\n'),
    powerCurve: [0, 1, 3, 5],
  },

  bladeVanguard: {
    defId: 'bladeVanguard',
    name: '炎刃军先锋',
    type: 'minion',
    cost: 1,
    power: 2,
  },

  bladeScout: {
    defId: 'bladeScout',
    name: '炎刃斥候',
    type: 'minion',
    cost: 0,
    power: 1,
    /**
     * 样例卡里**唯一一条已经写成「触发效果」**的文本 —— 它确认了两件事：
     *  - 「展示时」确实是一个触发时机，与 A5 补充 1 的「如有效果则触发对应效果」对上了；
     *  - 存在**可选动作**（「可以被除外」），需要玩家选择 → 与 D4 `pendingChoice` 直接相关。
     *
     * ⚠️ 仍不实现：效果的具体结算规则（选择时机、默认选项、超时处理）未给，
     * 且 `pendingChoice` 是否引入尚未定（D4）。
     */
    text: '这张牌从卡组展示时，可以被除外，如果除外且被展示的这张卡本应置入伤害区，将卡组顶一张卡片置入伤害区。',
  },

  bladeTactician: {
    defId: 'bladeTactician',
    name: '炎刃军师',
    type: 'minion',
    cost: 1,
    power: 1,
    /** 「登场时」触发 + 授予式效果 —— 效果清单未给，只转录。 */
    text:
      '每回合一次，这张卡在场时，这个回合获得效果【每当有一个【炎刃】随从登场，' +
      '那个随从力量值+1，这个效果这个回合最多发动次数为指挥官当前除外区的炎刃个数】。',
  },

  bladeOrder: {
    defId: 'bladeOrder',
    name: '炎刃号令',
    type: 'spell',
    cost: 1,
    /** 法术无力量值，记 0（与测试夹具口径一致）。 */
    power: 0,
    text: '展示卡组顶7张卡，选择其中一个力量值在你除外区的炎刃数量以下的随从召唤。',
  },

  /* ------------------------------------------------------------------ *
   * ↓↓↓ 以下为**占位卡**（我方补齐，非 Era 输入） ↓↓↓
   *
   * 授权来源：Era 2026-10-13 —— 「其他卡组内容先由你生成补充完整」。
   *
   * 补齐的**唯一目的**：让「能组出 30 张合法主卡组」这件事成立，
   * 从而把会话层 → 引擎的联机链路真正跑通（此前卡池只有 4 种非指挥官卡，
   * 受同名上限 3 约束最多 12 张，永远开不了局）。
   *
   * ⚠️ 三条自律（与 ADR-0015 §2 一致）：
   *  1. **只给数值** —— `cost` / `power` / `type`，一律**不写 `text`**，
   *     因为效果属于玩法，Era 未给，写了就是发明。
   *  2. **不引入新关键词** —— 仅用 A7 已定义的 `taunt`。
   *  3. **不写 `damage`** —— 缺失时按 X-5 取默认 1。
   *
   * 数值规则（`power = cost + 1` 基线，带关键词者按「补偿」下调）：
   *  `cost 0 → power 1`、`cost 1 → power 2`、`cost 2 → power 3`…
   *  带 `taunt` 的随从力量下调 1（用控制力换场面）。
   *
   * 📌 Era 给出正式卡表后：直接整批替换这 8 张，无需改任何机制代码。
   * ------------------------------------------------------------------ */

  bladeRecruit: { defId: 'bladeRecruit', name: '炎刃新兵', type: 'minion', cost: 0, power: 1 },
  bladeGuard: {
    defId: 'bladeGuard',
    name: '炎刃卫士',
    type: 'minion',
    cost: 2,
    // 带 taunt → 按数值规则下调 1（3 → 2）
    power: 2,
    keywords: [KEYWORD_TAUNT],
  },
  bladeKnight: { defId: 'bladeKnight', name: '炎刃骑士', type: 'minion', cost: 3, power: 4 },
  bladeCaptain: { defId: 'bladeCaptain', name: '炎刃队长', type: 'minion', cost: 4, power: 5 },
  bladeVeteran: { defId: 'bladeVeteran', name: '炎刃老兵', type: 'minion', cost: 5, power: 6 },
  bladeChampion: { defId: 'bladeChampion', name: '炎刃勇士', type: 'minion', cost: 6, power: 7 },
  bladeTactics: { defId: 'bladeTactics', name: '炎刃战术', type: 'spell', cost: 2, power: 0 },
  bladeBanner: {
    defId: 'bladeBanner',
    name: '炎刃战旗',
    type: 'continuous',
    cost: 3,
    power: 0,
  },
};

/**
 * **占位卡清单** —— 由我方补齐，等待 Era 的正式卡表整体替换。
 *
 * 单独维护这张表，是为了让「哪些数据是临时的」这件事**可枚举、可核对**：
 * 卡池会随 Era 的输入不断膨胀，若没有显式清单，占位数据很容易被淹没、
 * 最后当成既有设计的一部分留在正式版本里。
 */
export const PLACEHOLDER_CARD_IDS: readonly string[] = [
  'bladeRecruit',
  'bladeGuard',
  'bladeKnight',
  'bladeCaptain',
  'bladeVeteran',
  'bladeChampion',
  'bladeTactics',
  'bladeBanner',
];

/**
 * 卡名类别判定 —— 卡面文本多处引用「卡名包含『炎刃』的卡」
 * （统领的效果等级计数、号令的召唤上限）。
 *
 * 这是**卡面文本给定的判定口径**（原文即「卡名包含炎刃」），不是我方发明，
 * 故实现为纯字符串包含判断。若 Era 后续给出正式「字段 / 类别」定义，改这里即可。
 */
export function isBladeCard(def: CardDef): boolean {
  return def.name.includes('炎刃');
}
