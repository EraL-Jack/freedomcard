import { KEYWORD_TAUNT } from './constants.js';
import type { CardDef } from './types.js';

/**
 * 卡池（卡定义表）—— **双阵营 30 张**（炎刃 15 + 霜律 15）。
 *
 * ## 数据来源
 *
 * 1. **Era 原始 5 张**（`docs/10` 转录件）：`cost` / `power` / `type` / `text` 照抄卡面，
 *    不改编排。
 * 2. **8 张原占位卡**：Era 2026-10-19 采纳 `docs/12` 设计稿，**数值不动、补上效果文本**，
 *    由 `PLACEHOLDER_CARD_IDS` 移出，转为正式卡。
 * 3. **炎刃新增 2 张**（`bladeCremation` / `bladePhoenix`）与**霜律 15 张**：
 *    来自 `docs/12`，Era 2026-10-19 指示直接实现。
 *
 * ## 纪律
 *
 * - `text` 是**卡面原文**，供 UI 展示与人工核对；效果的可执行实现在
 *   `core/src/effects/*`（一卡一模块），不解析此文本。
 * - `damage` 只在卡面写明时写入；未写的按 `DEFAULT_DAMAGE`（X-5）。
 *   但打脸伤害现在按力量分档（docs/16 §5.5），`damage` 是**例外覆盖**。
 * - 霜冻不是卡面关键词常量，而是实例状态位（ADR-0025）—— 卡面文本里写「霜冻」即可。
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
      '力量值0-1-3-5 力量值提升，在每回合充能阶段执行',
      'Ⅰ 【2】每回合一次，可以根据除外区的卡名包含炎刃的卡的数量执行以下最多3个效果，每个效果最多一次：',
      '1个：从墓地选择一个力量值在除外区炎刃数量等级以下的随从，召唤',
      '3个：选择一个随从，本回合力量值+1',
      '5个：选择一个力量值在除外区炎刃数量等级以下的随从，破坏',
      '7个：选择一个随从，本回合对指挥官伤害+1',
      '9个：选择一个随从，一回合一次，攻击后重置',
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
    text: '这张牌从卡组展示时，可以被除外，如果除外且被展示的这张卡本应置入伤害区，将卡组顶一张卡片置入伤害区。',
  },

  bladeTactician: {
    defId: 'bladeTactician',
    name: '炎刃军师',
    type: 'minion',
    cost: 1,
    power: 1,
    text:
      '每回合一次，这张卡在场时，这个回合获得效果【每当有一个【炎刃】随从登场，' +
      '那个随从力量值+1，这个效果这个回合最多发动次数为指挥官当前除外区的炎刃个数】。',
  },

  bladeOrder: {
    defId: 'bladeOrder',
    name: '炎刃号令',
    type: 'spell',
    cost: 1,
    power: 0,
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
    text: '登场时：将卡组顶一张卡置入墓地；若该卡卡名包含「炎刃」，你可以将其除外。',
  },

  bladeKnight: {
    defId: 'bladeKnight',
    name: '炎刃骑士',
    type: 'minion',
    cost: 3,
    power: 4,
    text: '攻击时：你可以将墓地一张卡名包含「炎刃」的卡除外；若如此做，本回合此卡力量值+1。',
  },

  bladeCaptain: {
    defId: 'bladeCaptain',
    name: '炎刃队长',
    type: 'minion',
    cost: 4,
    power: 5,
    text: '每当你有一个其他卡名包含「炎刃」的随从登场时，该随从本回合力量值+1。',
  },

  bladeVeteran: {
    defId: 'bladeVeteran',
    name: '炎刃老兵',
    type: 'minion',
    cost: 5,
    power: 6,
    text: '登场时：你可以将墓地一张卡名包含「炎刃」的卡除外；若如此做，抽一张牌。',
  },

  bladeChampion: {
    defId: 'bladeChampion',
    name: '炎刃勇士',
    type: 'minion',
    cost: 6,
    power: 7,
    text: '登场时：你的除外区每有3张卡名包含「炎刃」的卡，本回合此卡力量值+1（最多+3）。',
  },

  bladeTactics: {
    defId: 'bladeTactics',
    name: '炎刃战术',
    type: 'spell',
    cost: 2,
    power: 0,
    text: '选择一个己方随从：本回合其力量值+2。若你的除外区有3张以上卡名包含「炎刃」的卡，改为+3。',
  },

  bladeBanner: {
    defId: 'bladeBanner',
    name: '炎刃战旗',
    type: 'continuous',
    cost: 3,
    power: 0,
    text: '每回合一次：当一张卡名包含「炎刃」的卡被除外时，抽一张牌。',
  },

  bladeCremation: {
    defId: 'bladeCremation',
    name: '炎刃焚典',
    type: 'spell',
    cost: 2,
    power: 0,
    text: '展示卡组顶4张卡。将其中任意数量的卡名包含「炎刃」的卡除外，其余置入墓地。',
  },

  bladePhoenix: {
    defId: 'bladePhoenix',
    name: '炎刃凤凰',
    type: 'minion',
    cost: 7,
    power: 7,
    damage: 2,
    text: '登场时：将你墓地中所有卡名包含「炎刃」的卡除外。每除外一张，本回合此卡力量值+1（最多+5）。',
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
      '力量值0-1-2-4 力量值提升，在每回合充能阶段执行',
      'Ⅰ 【2】每回合一次：霜冻一个敌方随从。',
      'Ⅱ 每回合一次：当一个敌方随从被霜冻时，抽一张牌。',
    ].join('\n'),
    powerCurve: [0, 1, 2, 4],
  },

  frostRecruit: { defId: 'frostRecruit', name: '霜律新兵', type: 'minion', cost: 0, power: 1 },

  frostApprentice: {
    defId: 'frostApprentice',
    name: '霜律学徒',
    type: 'minion',
    cost: 1,
    power: 1,
    text: '登场时：霜冻一个敌方随从。',
  },

  frostWarden: {
    defId: 'frostWarden',
    name: '霜律戍卫',
    type: 'minion',
    cost: 1,
    power: 1,
    keywords: [KEYWORD_TAUNT],
    text: '当此卡被攻击时，攻击者本回合力量值-1。',
  },

  frostBinder: {
    defId: 'frostBinder',
    name: '霜律缚锁者',
    type: 'minion',
    cost: 2,
    power: 2,
    text: '登场时：霜冻一个敌方随从；若该随从已处于霜冻状态，改为抽一张牌。',
  },

  frostLancer: {
    defId: 'frostLancer',
    name: '霜律长枪兵',
    type: 'minion',
    cost: 2,
    power: 2,
    text: '此卡攻击处于霜冻状态的随从时，力量值+2。',
  },

  frostEnforcer: {
    defId: 'frostEnforcer',
    name: '霜律执法者',
    type: 'minion',
    cost: 3,
    power: 3,
    text: '每当一个敌方随从被霜冻时，本回合此卡力量值+1，每回合最多+2。',
  },

  frostNightwatch: {
    defId: 'frostNightwatch',
    name: '霜律守夜人',
    type: 'minion',
    cost: 4,
    power: 4,
    text: '登场时：霜冻至多两个敌方随从。',
  },

  frostJailer: {
    defId: 'frostJailer',
    name: '霜律典狱长',
    type: 'minion',
    cost: 5,
    power: 5,
    text: '登场时：霜冻所有敌方随从。',
  },

  frostWinterblade: {
    defId: 'frostWinterblade',
    name: '霜律凛冬之刃',
    type: 'minion',
    cost: 6,
    power: 6,
    damage: 2,
    text: '登场时：霜冻所有敌方随从。',
  },

  frostEdict: {
    defId: 'frostEdict',
    name: '霜律律令',
    type: 'spell',
    cost: 1,
    power: 0,
    text: '霜冻一个敌方随从；若其力量值大于等于4，抽一张牌。',
  },

  frostColdSnap: {
    defId: 'frostColdSnap',
    name: '霜律寒流',
    type: 'spell',
    cost: 2,
    power: 0,
    text: '霜冻至多两个敌方随从。',
  },

  frostJudgment: {
    defId: 'frostJudgment',
    name: '霜律审判',
    type: 'spell',
    cost: 3,
    power: 0,
    text: '选择一个敌方随从：若它处于霜冻状态，破坏它；否则霜冻它。',
  },

  frostFinalJudgment: {
    defId: 'frostFinalJudgment',
    name: '霜律终裁',
    type: 'spell',
    cost: 5,
    power: 0,
    text: '破坏所有处于霜冻状态的敌方随从。每破坏一个，对敌方指挥官造成1点伤害。',
  },

  frostDomain: {
    defId: 'frostDomain',
    name: '霜律寒域',
    type: 'continuous',
    cost: 3,
    power: 0,
    text: '敌方处于霜冻状态的随从力量值-1。',
  },
};

/**
 * **占位卡清单** —— 已清空（ADR-0025）。
 *
 * 原 8 张占位卡在 `docs/12` 采纳后转为正式卡（数值不变、补上效果文本）。
 * 保留这个导出的空数组是为了让既有测试与文档引用不中断；
 * 将来若再出现临时数据，仍应在此显式枚举。
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

/**
 * 可主动发动的效果清单（客户端渲染用；服务端仍按 `EFFECTS` 注册表裁决）。
 *
 * 放在 shared 是因为**卡面效果属于卡数据**，客户端需要知道该给哪些卡显示发动按钮。
 * 具体能否发动（回合 / 次数 / 费用 / 目标）一律由服务端判断，客户端只做展示门槛。
 */
export const ACTIVATABLE_EFFECTS: Readonly<
  Record<string, readonly { id: string; label: string; zone: 'commander' | 'board' }[]>
> = {
  bladeLord: [
    { id: '1', label: '发动 效果Ⅰ：付 2 张费用，按除外区「炎刃」数执行至多 3 项', zone: 'commander' },
    { id: '2', label: '发动 效果Ⅱ：将一张手牌除外', zone: 'commander' },
  ],
  bladeTactician: [
    {
      id: '1',
      label: '发动：本回合己方炎刃随从登场时力量 +1（次数 = 除外区炎刃数）',
      zone: 'board',
    },
  ],
  frostAdjudicator: [
    { id: '1', label: '发动 效果Ⅰ：付 2 张费用，霜冻一个敌方随从', zone: 'commander' },
  ],
};
