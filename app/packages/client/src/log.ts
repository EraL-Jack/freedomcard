// `ZONES` 只有 core 导出（shared 只有类型），而类型是 shared 的 —— 两边都要引。
import { ZONES } from '@app/core';
import type { GameEvent, GameState, PlayerState, Zone } from '@app/shared/types';

import { CARD_POOL } from '@app/shared/cards';

import { PHASE_LABEL, ZONE_LABEL } from './labels.js';

/**
 * 事件 → 中文日志文案。
 *
 * ⚠️ 这是**表现层**的翻译，不是规则：它只把引擎产出的事件讲成人话，不参与任何结算。
 * B2-5 要求「日志在对战桌右边单独一列」，而引擎事件是英文标识符，
 * 故需要在客户端做这一层映射。
 *
 * 卡名从共享卡池查得 —— 这也是卡池必须放在 `shared` 的原因（ADR-0020）。
 */

/** 战报在界面上只保留最近 N 条（B2-5：长局会有几百条，全量渲染没必要）。 */
export const LOG_LIMIT = 200;

/** 战报一行。`id` 只做 React key，不承载任何语义。 */
export interface LogEntry {
  id: number;
  at: number;
  text: string;
  /**
   * **机制行**（#157）—— 阶段切换 / 重置 / 自动充能 / 费用上限。
   *
   * 这些不是「谁做了什么」，而是引擎在自动推进。它们默认**不显示**，
   * 靠战报面板的「细节」开关打开。
   *
   * 为什么不直接从日志里删掉：复盘时要能回答「这一回合到底发生了什么」，
   * 机制行是时间轴骨架。删掉是丢信息，藏起来只是降噪。
   */
  mech?: boolean;
}

/**
 * 算作「机制行」的事件（#157）。
 *
 * 判据是**主语**，不是重要性：
 *  - 主语是系统（阶段、重置、自动收入、上限抬升）→ 机制；
 *  - 主语是玩家或某张牌（出牌、攻击、破坏、抽牌、受伤）→ 战报正文。
 *
 * 「玩家抽了 1 张」不进这里：它是玩家的动作结果，一回合就 1~2 行。
 */
const MECH_EVENTS: ReadonlySet<string> = new Set([
  'phase:changed',
  'units:reset',
  'cost:income',
  'maxCost:changed',
]);

/** 这条事件是不是机制行（#157）。调用方据此把 `mech` 传给 `pushLogLine`。 */
export function isMechanism(type: string): boolean {
  return MECH_EVENTS.has(type);
}

/**
 * 追加一行战报并截到 `LOG_LIMIT` 条（#135 / D-291）。
 *
 * `id` 必须由**单调自增计数器**提供，绝不能取 `prev.length + 1`：
 * 数组被截到 200 条后长度**恒为 200**，此后每条新行的 id 都是 201 ——
 * React 报 key 冲突并可能重复渲染或吞掉行。
 * 战报是复盘的唯一凭据，行序不可信等于所有基于战报的结论都不可信。
 *
 * @param seq 调用方维护的单调序号（`useRoom` 用 `useRef`）
 */
export function pushLogLine(
  prev: readonly LogEntry[],
  at: number,
  text: string,
  seq: number,
  mech = false,
): LogEntry[] {
  return [...prev, { id: seq, at, text, ...(mech ? { mech: true } : {}) }].slice(-LOG_LIMIT);
}

/** 取卡名；查不到定义时退回 `defId`，避免出现空白格。 */
function cardName(defId: string | undefined): string {
  if (!defId) return '—';
  return CARD_POOL[defId]?.name ?? defId;
}

/** 取玩家显示名；查不到昵称时退回 `playerId` 前 6 位。 */
function who(names: Readonly<Record<string, string>>, playerId: unknown): string {
  if (typeof playerId !== 'string') return '—';
  return names[playerId] ?? playerId.slice(0, 6);
}

/** 按 uid 反查 defId —— 事件的 payload 只带 uid，卡名要到状态里查。 */
function defIdOf(state: GameState | null, uid: unknown): string | undefined {
  if (!state || typeof uid !== 'string') return undefined;
  for (const id of state.seats) {
    const p: PlayerState | undefined = state.players[id];
    if (!p) continue;
    for (const z of ZONES) {
      const card = p.zones[z].find((x) => x.uid === uid);
      if (card) return card.defId;
    }
  }
  return undefined;
}

function zoneText(zone: unknown): string {
  if (typeof zone !== 'string') return '?';
  return ZONE_LABEL[zone as Zone] ?? zone;
}

/**
 * 这个 uid 是不是某方的**指挥官**（#156）。
 *
 * 为什么需要它：`attack.ts` 对「随从打脸」硬编码了 `outcome: 'defender'` 与
 * `defPower: 0`，照字面渲染会得到「裁决 5 vs 0 → 防守方破坏」——
 * 一句说「有东西被破坏」但其实什么都没坏的话，而打脸是最频繁的结算路径。
 * 判断依据只能是区域（`commander` 区恒为 1 张），事件本身不带这个信息。
 */
function isCommanderUid(state: GameState | null, uid: unknown): boolean {
  if (!state || typeof uid !== 'string') return false;
  for (const id of state.seats) {
    const p: PlayerState | undefined = state.players[id];
    if (p?.zones.commander.some((c) => c.uid === uid)) return true;
  }
  return false;
}

/**
 * 区域可见性表 —— `docs/16 §7.5`（Era 2026-10-22 拍板 C-06）：
 * 一张牌对对手可见与否**只取决于它当时所在的区**，与「怎么进来的」无关。
 *
 * | 分类 | 区域 | 对手可见 |
 * | --- | --- | --- |
 * | 隐藏区 | 手牌、牌库 | 不可见（连牌名都不可见） |
 * | 公开区 | 场上 / **费用区** / 弃牌区 / 除外区 / 指挥官区 / 展示区 | 可见（含牌名） |
 *
 * ## 为什么不再逐事件枚举
 *
 * 旧实现是两条 `if`：`deck → hand` 一条、`deck → cost` 一条。第二条判断错了
 * ——把「回合充能」也当成隐藏信息（#136 收口过头，而这个「收口」本身是我越权加的，
 * Era 从未批过），于是 #143 又要改回来。两次返工都发生在「这条流向算不算公开」上。
 * 改成查表后，新增动作（弃置 / 洗回 / 置底）不用再改分支：看终点在哪就行。
 */
const HIDDEN_ZONES: ReadonlySet<string> = new Set(['hand', 'deck']);

/** 这张牌「现在 / 刚才」待在公开区吗（任一端点公开即可见，见 `card:moved` 的注释）。 */
function isPublicZone(zone: string | undefined): boolean {
  return zone !== undefined && !HIDDEN_ZONES.has(zone);
}

function phaseText(phase: unknown): string {
  if (typeof phase !== 'string') return '?';
  return PHASE_LABEL[phase as keyof typeof PHASE_LABEL] ?? phase;
}

const OUTCOME_LABEL: Readonly<Record<string, string>> = {
  defender: '防守方破坏',
  attacker: '攻击方破坏',
  both: '双方破坏',
};

/**
 * 把一条事件翻译成一行日志。
 *
 * 返回 `null` 表示「不进日志」，目前两类：
 *  - `rng:advance`：纯记账事件，对玩家无信息量；
 *  - `attack:declared` / `trigger:*`：会被随后的 `combat:resolved` 合并成一行，
 *    单独成行只会让一次攻击刷出 4 条记录。
 *
 * @param e 引擎事件
 * @param names `playerId → 昵称`
 * @param state **reduce 之后**的状态（按 uid 反查卡名要用它）
 * @param viewer 当前视角玩家（`useRoom` 里的 `me`）。**`null` 表示「未知视角」，
 *   按「看不到对手手牌」处理（fail-closed）** —— 将来新增调用点忘记传视角时，
 *   宁可少显示，也不要泄露对手手牌（issue #136）。
 */
export function describeEvent(
  e: GameEvent,
  names: Readonly<Record<string, string>>,
  state: GameState | null,
  viewer: string | null = null,
): string | null {
  const p = e.payload ?? {};
  const str = (k: string): string | undefined =>
    typeof p[k] === 'string' ? (p[k] as string) : undefined;
  const num = (k: string): number | undefined =>
    typeof p[k] === 'number' ? (p[k] as number) : undefined;

  switch (e.type) {
    case 'rng:advance':
      return null;

    case 'game:started':
      return '对局开始';

    case 'commander:revealed':
      return `揭示指挥官：${cardName(str('defId'))}`;

    case 'deck:shuffled': {
      /*
       * D-263（issue #91）：卡组抽空把弃牌区洗回来时，`reason` 是 `reshuffle`，
       * `order` 就是这一批洗回的牌。玩家需要看到「牌去哪儿了」——
       * 否则卡组区显示 0、弃牌区显示 15，点抽牌却什么都没发生。
       */
      if (str('reason') === 'reshuffle') {
        const order = Array.isArray(p['order']) ? p['order'] : [];
        return `${who(names, str('playerId'))} 把弃牌区 ${order.length} 张洗回卡组`;
      }
      return `${who(names, str('playerId'))} 洗牌`;
    }

    case 'card:moved': {
      const from = str('from');
      const to = str('to');
      // 展示区是**内部中转**（Era 2026-10-20）：进出展示区不写日志，
      // 玩家只需要看到「展示：X」（card:revealed），否则会多出两条无信息的位移行。
      if (to === 'reveal') return null;
      if (from === 'reveal') return null;
      const name = cardName(defIdOf(state, str('uid')));
      /*
       * 可见性**查表**（`docs/16 §7.5`，Era 2026-10-22 拍板 C-06）—— 见文件头的
       * `HIDDEN_ZONES`。判定只看区域，不看「怎么进来的」：
       *
       *  - 两端都在隐藏区（手牌 / 牌库之间）→ 对手只知道「有 1 张牌动了」。
       *    抽牌就是这一类（`deck → hand`），所以对手只记「抽了 1 张」；
       *    **自己**看得见自己的手牌，所以自己的抽牌照旧念卡名。
       *  - 任一端点是公开区 → 念卡名。`deck → cost`（回合强制充能）属这一条：
       *    终点是**费用区**，费用区是公开区，所以对手看得见是哪张牌（#143）。
       *    这条**不看 `viewer`** —— 公开信息不该因为少传视角就消失。
       *
       * `viewer` 为 `null`（未知视角）时按「看不到对手手牌」处理（fail-closed）：
       * 新增调用点忘记传视角时，宁可少显示，也不要泄露对手手牌。
       *
       * ⚠️ 「任一端点公开即可见」是刻意的：`board → hand`（回手）时对手早就在
       * 桌面上看见过这张牌，把卡名抹掉不会更安全，只会让战报比桌面更封闭
       * （§7.5.3「战报不得比桌面更公开」的另一半）。
       */
      const ownerId = str('playerId');
      if (!isPublicZone(from) && !isPublicZone(to)) {
        if (ownerId !== undefined && ownerId === viewer) {
          return from === 'deck' && to === 'hand'
            ? `${who(names, ownerId)} 抽到 ${name}`
            : `${name}：${zoneText(from)} → ${zoneText(to)}`;
        }
        return from === 'deck' && to === 'hand'
          ? `${who(names, ownerId)} 抽了 1 张`
          : `${who(names, ownerId)} 移动了 1 张牌（${zoneText(from)} → ${zoneText(to)}）`;
      }
      /*
       * D-263：洗回的搬移是「实现细节」，一条 `deck:shuffled`（reason=reshuffle）
       * 已经说清「弃牌区 N 张洗回卡组」。逐张再印 N 行「X：弃牌区 → 卡组」
       * 会把整页日志刷掉（实测 15 张就够呛）。
       */
      if (from === 'graveyard' && to === 'deck') return null;
      // 顶替离场（D-257）：上一行 `unit:replaced` 已经说明「被顶替、进弃牌区」，
      // 这里再印「被破坏」会让玩家以为是战斗结果。
      if (p['replaced'] === true) return null;
      if (from === 'board' && to === 'graveyard') return `${name} 被破坏`;
      /*
       * 进费用区（回合强制充能 / 手牌充能 / 场上充能）统一一句话 —— 费用区是公开区，
       * 谁的牌都念卡名（#143 / `docs/16 §7.5.1`）。
       *
       * 自己的文案一个字都不改：E2E、肌肉记忆与「充能 = 置入费用区」的说法都依赖它。
       * 对手的加归属前缀 —— 双方共用一列战报，只写「霜律终裁 置入费用区」
       * 会让人分不清是你充的还是他充的。
       */
      if (to === 'cost') {
        return ownerId !== undefined && ownerId !== viewer
          ? `${who(names, ownerId)} 将 ${name} 置入费用区`
          : `${name} 置入费用区`;
      }
      if (to === 'board') return `${name} 登场`;
      if (from === 'cost' && to === 'graveyard') return null;
      /*
       * 支付费用是**一次动作 N 张**（#157）：`cost:spent` 已经写了
       * 「Era 消耗 4 张费用」，再逐张印「X：费用区 → 弃牌区」就是 4 行噪音。
       * 实测一次出牌 6 行（4 张费用 + 消耗 + 登场），玩家根本读不下去。
       *
       * 与 D-263（洗回不逐张印）同一个判断：**被另一条事件完整概括的位移，
       * 不再单独成行**。信息没丢 —— 消耗几张在 `cost:spent`，去哪了由区域语义决定。
       */
      return `${name}：${zoneText(from)} → ${zoneText(to)}`;
    }

    case 'mulligan:done':
      return `${who(names, str('playerId'))} 完成换牌`;

    case 'units:reset':
      return '重置阶段：清除休眠';

    case 'unit:asleep':
      return `${cardName(defIdOf(state, str('uid')))} 进入休眠`;

    /* D-257：顶替召唤 —— 玩家需要知道「原来那张去哪了」（弃牌区），否则会当成丢失。 */
    case 'unit:replaced': {
      const slot = num('slot');
      const byUid = str('byUid');
      return `${cardName(defIdOf(state, byUid))} 被顶替出场（第 ${(slot ?? 0) + 1} 格），置入弃牌区`;
    }

    case 'unit:frozen':
      return `${cardName(defIdOf(state, str('uid')))} 被冻结（跳过下次重置）`;

    case 'commander:attacked':
      // 「电脑 的指挥官」多一个空格（#156-3）：中文里昵称后面直接跟「的」。
      return `${who(names, str('playerId'))}的指挥官发起攻击`;

    case 'cost:spent':
      return `${who(names, str('playerId'))} 消耗 ${num('amount') ?? 0} 张费用`;

    /* D-258：回合开始的自动充能 —— 与手动充能分开说，否则玩家不知道这两张是白来的。 */
    case 'cost:income':
      return `⚡ ${who(names, str('playerId'))} 充能阶段自动 +${num('amount') ?? 0} 张费用`;

    case 'commander:damaged': {
      /*
       * #156：带 `sourceUid` 时说清「谁打的」（事件里有这张牌的 uid）——
       * 光写「指挥官受到 2 点伤害」时，玩家分不清是随从打脸还是法术直伤。
       * 动词按卡类型分开：随从 / 指挥官是「直击」，法术 / 设置是「造成」。
       */
      const amount = num('amount') ?? 1;
      const source = str('sourceUid');
      const defId = source ? defIdOf(state, source) : undefined;
      if (!defId) return `指挥官受到 ${amount} 点伤害`;
      const name = cardName(defId);
      const type = CARD_POOL[defId]?.type;
      return type === 'minion' || type === 'commander'
        ? `${name} 直击指挥官 → 造成 ${amount} 点伤害`
        : `${name} 对指挥官造成 ${amount} 点伤害`;
    }

    case 'card:revealed':
      return `展示：${cardName(defIdOf(state, str('uid')))}`;

    /* ---- D-229 / D-230：成长资源与新事件 ---- */
    case 'frost:mark':
      return `${who(names, str('playerId'))} 获得 ${num('amount') ?? 1} 层霜痕`;

    case 'star:mark':
      return `${who(names, str('playerId'))} 获得 ${num('amount') ?? 1} 层星轨`;

    case 'commander:damage-bonus':
      return `${who(names, str('playerId'))} 的指挥官本回合伤害 +${num('amount') ?? 1}`;

    case 'cost:discount':
      return `${who(names, str('playerId'))} 的下一张随从费用 -${num('amount') ?? 1}`;

    case 'card:created':
      return `${cardName(str('defId'))} 被召唤`;

    case 'deck:put-bottom':
      return null; // 展示后的归位，展示那一行已经说清楚了

    case 'combat:resolved': {
      /*
       * #156：打指挥官不写「裁决」行。
       *
       * `attack.ts` 对打脸硬编码 `outcome: 'defender'` + `defPower: 0`，
       * 照字面就成了「裁决 5 vs 0 → 防守方破坏」—— 没有任何东西被破坏，
       * 而这是每回合都会出现的最频繁路径。谁打的脸、掉多少血，
       * 由紧随其后的 `commander:damaged` 那行说清楚。
       */
      if (isCommanderUid(state, str('targetUid'))) return null;
      return `裁决 ${num('atkPower')} vs ${num('defPower')} → ${OUTCOME_LABEL[str('outcome') ?? ''] ?? '?'}`;
    }

    case 'health:changed':
      return `${who(names, str('playerId'))} 血量 → ${num('value') ?? '?'}`;

    case 'maxCost:changed':
      return `${who(names, str('playerId'))} 最高费用 → ${num('value') ?? '?'}`;

    case 'phase:changed':
      return `阶段：${phaseText(str('from'))} → ${phaseText(str('to'))}`;

    case 'turn:changed':
      return `—— 第 ${num('turn') ?? '?'} 回合 ——`;

    /* ---- 效果系统（ADR-0023）：内部记账事件不进日志，玩家可见的给中文 ---- */
    case 'choice:pending':
    case 'choice:cleared':
    case 'choice:queued':
    case 'choice:dequeued':
      return null; // 选择的挂起/排队/清除由浮层呈现，日志不需要

    case 'effect:used':
      return `${who(names, str('playerId'))} 发动效果`;

    case 'unit:modified': {
      const name = cardName(defIdOf(state, str('uid')));
      const tp = num('tempPower');
      const td = num('tempDamage');
      if (tp) return `${name} 本回合力量 ${tp > 0 ? '+' : ''}${tp}`;
      if (td) return `${name} 本回合对指挥官伤害 ${td > 0 ? '+' : ''}${td}`;
      if (p['attackRefresh'] === true) return `${name} 获得「一回合一次，攻击后重置」`;
      if (p['attackRefresh'] === false) return `${name} 攻击后重置已生效（本回合已用完）`;
      return null;
    }

    case 'trigger:added':
      return `${who(names, str('playerId'))} 的军师效果生效中（本回合）`;

    case 'trigger:spent':
      return null; // 触发消耗已由 unit:modified 的那行表达

    case 'game:ended': {
      const w = str('winner');
      if (!w) return '对局结束：平局（40 轮未分胜负）';
      return `对局结束，胜者：${who(names, w)}`;
    }

    /*
     * ---- 故意不写日志 / 只写一句话的事件（#121 / D-291）----
     *
     * 原来这些落到 `default: return e.type`，于是玩家战报里出现
     * `draw:completed`、`mulligan:closed` 这类**英文协议串**。
     * 中文界面里蹦出冒号串，玩家的第一反应是「报错了」——
     * 而战报是他理解局面的主要凭据，混进技术字符串会拉低整块日志的可信度。
     *
     * 这里的每个类型都是对照 `core/src/reducer.ts` 的 `case` 逐个核对过的
     * （2026-10-22，41 个类型全部分类完毕，没有漏网的）。
     */
    case 'attack:declared':
    case 'trigger:attack':
    case 'trigger:defend':
      return null; // 攻击过程的中间事件，合并进 `combat:resolved` 一行
    case 'draw:completed':
      return null; // 抽牌阶段收尾标记；动效已给「抽牌完成」，阶段行也有
    case 'card:pending-buff':
      return null; // 顶替 / 预增益的记账，属内部状态
    case 'commander:grown':
      return null; // 指挥官力量值已取消（docs/16 §6.2.1），属遗留事件
    case 'mulligan:closed':
      return '换牌结束，进入第一回合';
    case 'sudden:death':
      return '⚡ 双方血量相同 —— 进入即死模式：此后任何一方掉血即判负';

    default:
      /*
       * 未映射的事件**不进玩家战报**（#121）—— 宁可少一行，也不要让玩家看到
       * 协议串。回放与服务端日志仍是全量（`docs/16 §7.5.4`）。
       *
       * 代价：以后新增事件若忘记补中文，它会在界面上「安静地消失」。
       * 这是刻意选的方向：少一行会被「局面对不上」发现，而协议串只会被当成报错。
       * 新增事件时**请回来补一条中文**，并在 `log.test.ts` 留一条断言。
       */
      return null;
  }
}
