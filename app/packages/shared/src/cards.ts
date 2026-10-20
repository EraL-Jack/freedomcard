import { KEYWORD_TAUNT } from './constants.js';
import type { CardDef } from './types.js';

/**
 * 卡池（卡定义表）—— **三阵营 45 张 + 2 张衍生物**（炎刃 15 + 霜律 15 + 星轨 15）。
 *
 * ## 数据来源
 *
 * 1. **Era 原始 5 张**（`docs/10` 转录件）：`cost` / `power` / `type` / `text` 照抄卡面。
 * 2. **`docs/12`**：炎刃 15 张 + 霜律 15 张（D-225 / D-229 修订）。
 * 3. **`docs/17`**：星轨 15 张（D-230 新增阵营）。
 * 4. **`docs/18-卡牌文本规范`**：卡面统一为「什么时候 → 花多少 → 做什么」，
 *    `【N】` 只出现在技能费用与时机之后；力量值变化写 `力量值 +N`。
 *
 * ## 纪律
 *
 * - `text` 只放**效果描述**，**不写费用 / 力量 / 伤害数值**（D-232）：
 *   数值由 `cost` / `power` / `damage` 字段渲染，局内显示的还是**实际值**
 *   （随从 −1 费、打脸伤害按力量分档）。文本里再抄一份必然与结算不一致 ——
 *   这正是「卡面写伤害值1、实际打 2 点」那类问题的根源（PM-02 / AR-22）。
 * - `text` 是**卡面原文**，供 UI 展示与人工核对；效果的可执行实现在
 *   `core/src/effects/*`（一卡一模块），不解析此文本。
 * - `damage` 只在卡面写明时写入；未写的按力量分档（docs/16 §5.5），
 *   `damage` 是**例外覆盖**。
 * - 冻结不是卡面关键词常量，而是实例状态位（ADR-0025）—— 卡面文本里写「冻结」即可。
 * - **指挥官没有力量值**（docs/16 §6.2.1）：首行只写「指挥官」，
 *   `powerCurve` 字段保留作历史、不参与任何判定。
 * - 指挥官技能费用固定 **2 费**（D-229 撤销 D-228 的「3 − 档位」）。
 */

export const CARD_POOL: Record<string, CardDef> = {
  /* ================================================================== *
   * 炎刃（Blade）—— 15 张
   * ================================================================== */

  bladeLord: {
    defId: 'bladeLord',
    name: '炎刃军统领',
    type: 'commander',
    cost: 0,
    power: 0,
    text: [
      '指挥官',
      'Ⅰ 每回合一次【2】：按除外区「炎刃」卡的数量，执行以下最多 3 个效果（每个效果最多一次）：',
      '  1 个：从你的弃牌区选择 1 个力量值不高于该数量的随从，召唤',
      '  3 个：选择 1 个己方随从，本回合力量值 +1',
      '  5 个：选择 1 个力量值不高于该数量的敌方随从，破坏',
      '  7 个：选择 1 个己方随从，本回合对指挥官伤害 +1',
      '  9 个：选择 1 个己方随从，本回合攻击后重置（每回合最多 1 次）',
      'Ⅱ 每回合一次：将 1 张手牌除外。',
    ].join('\n'),
    // 历史字段：指挥官力量值已取消（docs/16 §6.2.1），保留仅为旧数据兼容。
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
    // Era 原文不动（docs/12 §7.5 例外清单）
    text:
      '这张牌从卡组展示时，可以被除外，如果除外且被展示的这张卡本应置入伤害区，\n' +
      '将卡组顶一张卡片置入伤害区。',
  },

  bladeTactician: {
    defId: 'bladeTactician',
    name: '炎刃军师',
    type: 'minion',
    cost: 1,
    power: 1,
    // Era 原文不动（docs/12 §7.5 例外清单）
    text: [
      '每回合一次，这张卡在场时，这个回合获得效果【每当有一个【炎刃】随从登场，',
      '那个随从力量值+1，这个效果这个回合最多发动次数为指挥官当前除外区的炎刃个数】。',
    ].join('\n'),
  },

  bladeOrder: {
    defId: 'bladeOrder',
    name: '炎刃号令',
    type: 'spell',
    cost: 1,
    power: 0,
    // Era 原文不动（docs/12 §7.5 例外清单）
    text: '展示卡组顶7张卡，选择其中一个力量值在你除外区的炎刃数量以下的随从召唤。',
  },

  bladeRecruit: {
    defId: 'bladeRecruit',
    name: '炎刃新兵',
    type: 'minion',
    cost: 0,
    power: 1,
  },

  bladeGuard: {
    defId: 'bladeGuard',
    name: '炎刃卫士',
    type: 'minion',
    cost: 2,
    power: 2,
    keywords: [KEYWORD_TAUNT],
    text: [
      '登场时：将卡组顶 1 张卡置入弃牌区；若该卡为「炎刃」卡，你可以将其除外。',
    ].join('\n'),
  },

  bladeKnight: {
    defId: 'bladeKnight',
    name: '炎刃骑士',
    type: 'minion',
    cost: 3,
    power: 4,
    text: [
      '攻击时：你可以将弃牌区 1 张「炎刃」卡除外；若如此做，本回合此卡力量值 +1。',
    ].join('\n'),
  },

  bladeCaptain: {
    defId: 'bladeCaptain',
    name: '炎刃队长',
    type: 'minion',
    cost: 4,
    power: 5,
    text: [
      '其他己方「炎刃」随从登场时：该随从本回合力量值 +1。',
    ].join('\n'),
  },

  bladeVeteran: {
    defId: 'bladeVeteran',
    name: '炎刃老兵',
    type: 'minion',
    cost: 5,
    power: 6,
    text: [
      '登场时：你可以将弃牌区 1 张「炎刃」卡除外；若如此做，抽 1 张。',
    ].join('\n'),
  },

  bladeChampion: {
    defId: 'bladeChampion',
    name: '炎刃勇士',
    type: 'minion',
    cost: 6,
    power: 7,
    text: [
      '登场时：你的除外区每有 3 张「炎刃」卡，本回合此卡力量值 +1（最多 +3）。',
    ].join('\n'),
  },

  bladeTactics: {
    defId: 'bladeTactics',
    name: '炎刃战术',
    type: 'spell',
    cost: 2,
    power: 0,
    text: [
      '选择 1 个己方随从：本回合其力量值 +2。',
      '若你的除外区有 3 张及以上「炎刃」卡，改为 +3。',
    ].join('\n'),
  },

  bladeBanner: {
    defId: 'bladeBanner',
    name: '炎刃战旗',
    type: 'continuous',
    cost: 3,
    power: 0,
    text: '己方「炎刃」卡被除外时：抽 1 张（每回合最多触发 1 次）。',
  },

  bladeCremation: {
    defId: 'bladeCremation',
    name: '炎刃焚典',
    type: 'spell',
    cost: 2,
    power: 0,
    text: '展示卡组顶 4 张卡。将其中任意数量的「炎刃」卡除外，其余置入弃牌区。',
  },

  bladePhoenix: {
    defId: 'bladePhoenix',
    name: '炎刃凤凰',
    type: 'minion',
    cost: 7,
    power: 7,
    damage: 2,
    text: [
      '登场时：将你弃牌区中所有「炎刃」卡除外；每除外 1 张，本回合此卡力量值 +1（最多 +5）。',
    ].join('\n'),
  },

  /* ================================================================== *
   * 霜律（Frost）—— 15 张
   * ================================================================== */

  frostAdjudicator: {
    defId: 'frostAdjudicator',
    name: '霜律裁决官',
    type: 'commander',
    cost: 0,
    power: 0,
    text: [
      '指挥官',
      'Ⅰ 每回合一次【2】：按霜痕层数冻结未冻结的敌方随从：',
      '  0–2 层：冻结 1 个',
      '  3–5 层：冻结 1 个，抽 1 张',
      '  6–8 层：冻结 2 个',
      '  9 层及以上：冻结 2 个，抽 1 张',
      'Ⅱ 敌方随从被冻结时：抽 1 张（每回合最多触发 1 次）。',
      'Ⅲ 敌方随从被冻结时：你获得 1 层霜痕（永久累积，不清零）。',
    ].join('\n'),
    powerCurve: [0, 1, 2, 4],
  },

  frostRecruit: {
    defId: 'frostRecruit',
    name: '霜律新兵',
    type: 'minion',
    cost: 0,
    power: 1,
  },

  frostApprentice: {
    defId: 'frostApprentice',
    name: '霜律学徒',
    type: 'minion',
    cost: 1,
    power: 1,
    text: '登场时：冻结 1 个未冻结的敌方随从。',
  },

  frostWarden: {
    defId: 'frostWarden',
    name: '霜律戍卫',
    type: 'minion',
    cost: 1,
    power: 1,
    keywords: [KEYWORD_TAUNT],
    text: [
      '被攻击时：攻击者本回合力量值 -1。',
    ].join('\n'),
  },

  frostBinder: {
    defId: 'frostBinder',
    name: '霜律缚锁者',
    type: 'minion',
    cost: 2,
    power: 2,
    text: [
      '登场时：冻结 1 个敌方随从；若该随从已处于冻结状态，改为抽 1 张。',
    ].join('\n'),
  },

  frostLancer: {
    defId: 'frostLancer',
    name: '霜律长枪兵',
    type: 'minion',
    cost: 2,
    power: 2,
    text: [
      '攻击时：若目标处于冻结状态，本回合此卡力量值 +2。',
    ].join('\n'),
  },

  frostEnforcer: {
    defId: 'frostEnforcer',
    name: '霜律执法者',
    type: 'minion',
    cost: 3,
    power: 3,
    text: [
      '敌方随从被冻结时：本回合此卡力量值 +1（每回合最多 +2）。',
    ].join('\n'),
  },

  frostNightwatch: {
    defId: 'frostNightwatch',
    name: '霜律守夜人',
    type: 'minion',
    cost: 4,
    power: 4,
    text: '登场时：冻结至多 2 个未冻结的敌方随从。',
  },

  frostJailer: {
    defId: 'frostJailer',
    name: '霜律典狱长',
    type: 'minion',
    cost: 5,
    power: 5,
    text: '登场时：冻结所有敌方随从。',
  },

  frostWinterblade: {
    defId: 'frostWinterblade',
    name: '霜律凛冬之刃',
    type: 'minion',
    cost: 6,
    power: 6,
    damage: 2,
    text: '登场时：冻结所有敌方随从。',
  },

  frostEdict: {
    defId: 'frostEdict',
    name: '霜律律令',
    type: 'spell',
    cost: 1,
    power: 0,
    text: '冻结 1 个未冻结的敌方随从；若其力量值大于等于 4，抽 1 张。',
  },

  frostColdSnap: {
    defId: 'frostColdSnap',
    name: '霜律寒流',
    type: 'spell',
    cost: 2,
    power: 0,
    text: '冻结至多 2 个未冻结的敌方随从。',
  },

  frostJudgment: {
    defId: 'frostJudgment',
    name: '霜律审判',
    type: 'spell',
    cost: 3,
    power: 0,
    text: '选择 1 个敌方随从：若它处于冻结状态，破坏它；否则冻结它。',
  },

  frostFinalJudgment: {
    defId: 'frostFinalJudgment',
    name: '霜律终裁',
    type: 'spell',
    cost: 5,
    power: 0,
    text: [
      '破坏所有处于冻结状态的敌方随从。每破坏 1 个，对敌方指挥官造成 1 点伤害。',
    ].join('\n'),
  },

  frostDomain: {
    defId: 'frostDomain',
    name: '霜律寒域',
    type: 'continuous',
    cost: 3,
    power: 0,
    text: '设置：敌方处于冻结状态的随从力量值 -1。',
  },

  /* ================================================================== *
   * 星轨（Star Track）—— 15 张（docs/17 / D-230）
   * ================================================================== */

  starWatcher: {
    defId: 'starWatcher',
    name: '星轨观测者',
    type: 'commander',
    cost: 0,
    power: 0,
    text: [
      '指挥官',
      'Ⅰ 攻击时【1】：按星轨层数从卡组顶展示，触发其中所有「展示时」效果，然后将这些卡按原顺序置入牌库底：',
      '  0–2 层：2 张',
      '  3–5 层：3 张',
      '  6 层及以上：4 张',
      'Ⅱ 每当你展示 1 张卡时：获得 1 层星轨（永久累积，不清零）。',
    ].join('\n'),
  },

  starScout: {
    defId: 'starScout',
    name: '星轨斥候',
    type: 'minion',
    cost: 0,
    power: 1,
    text: '展示时：获得 1 层星轨。',
  },

  starAcolyte: {
    defId: 'starAcolyte',
    name: '星轨侍僧',
    type: 'minion',
    cost: 1,
    power: 1,
    text: '展示时：本回合你的指挥官伤害值 +1（不可叠加）。',
  },

  starArcher: {
    defId: 'starArcher',
    name: '星轨弓手',
    type: 'minion',
    cost: 1,
    power: 2,
    text: [
      '展示时：对敌方指挥官造成 1 点伤害（每回合最多触发 1 次）。',
    ].join('\n'),
  },

  starGuard: {
    defId: 'starGuard',
    name: '星轨守卫',
    type: 'minion',
    cost: 2,
    power: 2,
    keywords: [KEYWORD_TAUNT],
    text: '展示时：抽 1 张。',
  },

  starWeaver: {
    defId: 'starWeaver',
    name: '星轨织者',
    type: 'minion',
    cost: 2,
    power: 2,
    text: '展示时：召唤 1 个星灵（力量值1 / 伤害值1）。',
  },

  starLancer: {
    defId: 'starLancer',
    name: '星轨枪手',
    type: 'minion',
    cost: 3,
    power: 3,
    text: '展示时：本回合此卡力量值 +2。',
  },

  starHerald: {
    defId: 'starHerald',
    name: '星轨传令',
    type: 'minion',
    cost: 3,
    power: 3,
    text: '展示时：本回合你打出的下一张随从费用 -1。',
  },

  starGiant: {
    defId: 'starGiant',
    name: '星轨巨像',
    type: 'minion',
    cost: 5,
    power: 6,
    text: '展示时：本回合此卡力量值 +1。',
  },

  starSovereign: {
    defId: 'starSovereign',
    name: '星轨君王',
    type: 'minion',
    cost: 6,
    power: 7,
    damage: 2,
    text: '展示时：召唤 1 个星灵（力量值3 / 伤害值3）。',
  },

  starChart: {
    defId: 'starChart',
    name: '星图',
    type: 'spell',
    cost: 2,
    power: 0,
    text: '展示卡组顶 1 张卡，触发其中所有「展示时」效果，然后将它置入牌库底。',
  },

  starFall: {
    defId: 'starFall',
    name: '星陨',
    type: 'spell',
    cost: 2,
    power: 0,
    text: '对敌方指挥官造成 2 点伤害。',
  },

  starGaze: {
    defId: 'starGaze',
    name: '凝视星空',
    type: 'spell',
    cost: 3,
    power: 0,
    text: [
      '展示卡组顶 2 张卡，触发其中所有「展示时」效果。',
      '然后选择其中 1 张加入手牌，其余按原顺序置入牌库底。',
    ].join('\n'),
  },

  starBlessing: {
    defId: 'starBlessing',
    name: '星赐',
    type: 'spell',
    cost: 3,
    power: 0,
    text: '本回合你的所有随从力量值 +1。',
  },

  starOrbit: {
    defId: 'starOrbit',
    name: '星轨环',
    type: 'continuous',
    cost: 2,
    power: 0,
    text: '设置：每回合你第一次展示卡时，抽 1 张。',
  },

  /* ================================================================== *
   * 衍生物 —— 只能被效果召唤，不进卡组（docs/17 §4）
   * ================================================================== */

  starSpirit1: {
    defId: 'starSpirit1',
    name: '星灵',
    type: 'minion',
    cost: 0,
    power: 1,
  },

  starSpirit3: {
    defId: 'starSpirit3',
    name: '星灵',
    type: 'minion',
    cost: 0,
    power: 3,
  },
};

/**
 * **衍生物清单** —— 不进卡组、不参与同名上限校验、不计入 30 张主卡组。
 *
 * 单独列出是为了让 `checkDeck` 与卡组构筑逻辑能显式排除它们：
 * 衍生物被破坏后进弃牌区，但**不参与洗回**（docs/17 §4）。
 */
export const TOKEN_CARD_IDS: readonly string[] = ['starSpirit1', 'starSpirit3'];

/**
 * **占位卡清单** —— 已清空（ADR-0025）。
 *
 * 原 8 张占位卡在 `docs/12` 采纳后转为正式卡（数值不变、补上效果文本）。
 * 保留这个导出的空数组是为了让既有测试与文档引用不中断。
 */
export const PLACEHOLDER_CARD_IDS: readonly string[] = [];

/** 卡名类别判定 —— 卡面文本多处引用「卡名包含『炎刃』的卡」（原文口径，非我方发明）。 */
export function isBladeCard(def: CardDef): boolean {
  return def.name.includes('炎刃');
}

/** 霜律体系判定 —— 与 `isBladeCard` 同口径。 */
export function isFrostCard(def: CardDef): boolean {
  return def.name.includes('霜律');
}

/** 星轨体系判定 —— 与 `isBladeCard` 同口径。 */
export function isStarCard(def: CardDef): boolean {
  return def.name.includes('星轨') || def.name === '星灵';
}

/**
 * 可主动发动的效果清单（客户端渲染用；服务端仍按 `EFFECTS` 注册表裁决）。
 *
 * 放在 shared 是因为**卡面效果属于卡数据**，客户端需要知道该给哪些卡显示发动按钮。
 * 具体能否发动（回合 / 次数 / 费用 / 目标）一律由服务端判断，客户端只做展示门槛。
 *
 * ⚠️ `id` 与 `core/src/effects/*` 的 effectId 一一对应，改名等于改协议。
 */
export const ACTIVATABLE_EFFECTS: Readonly<
  Record<string, readonly { id: string; label: string; zone: 'commander' | 'board' }[]>
> = {
  bladeLord: [
    { id: '1', label: '发动 效果Ⅰ【2】：按除外区「炎刃」数执行至多 3 项', zone: 'commander' },
    { id: '2', label: '发动 效果Ⅱ：将 1 张手牌除外', zone: 'commander' },
  ],
  bladeTactician: [
    {
      id: '1',
      label: '发动：本回合己方「炎刃」随从登场时力量值 +1（次数 = 除外区「炎刃」数）',
      zone: 'board',
    },
  ],
  frostAdjudicator: [
    { id: '1', label: '发动 效果Ⅰ【2】：按霜痕层数冻结未冻结的敌方随从', zone: 'commander' },
  ],
};
