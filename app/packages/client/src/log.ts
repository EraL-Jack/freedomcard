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
 */
export function describeEvent(
  e: GameEvent,
  names: Readonly<Record<string, string>>,
  state: GameState | null,
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
      if (from === 'deck' && to === 'hand') return `${who(names, str('playerId'))} 抽到 ${name}`;
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
      if (to === 'cost') return `${name} 置入费用区`;
      if (to === 'board') return `${name} 登场`;
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
      return `${who(names, str('playerId'))} 的指挥官发起攻击`;

    case 'cost:spent':
      return `${who(names, str('playerId'))} 消耗 ${num('amount') ?? 0} 张费用`;

    /* D-258：回合开始的自动充能 —— 与手动充能分开说，否则玩家不知道这两张是白来的。 */
    case 'cost:income':
      return `⚡ ${who(names, str('playerId'))} 充能阶段自动 +${num('amount') ?? 0} 张费用`;

    case 'commander:damaged':
      return `指挥官受到 ${num('amount') ?? 1} 点伤害`;

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

    case 'combat:resolved':
      return `裁决 ${num('atkPower')} vs ${num('defPower')} → ${OUTCOME_LABEL[str('outcome') ?? ''] ?? '?'}`;

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

    default:
      return e.type;
  }
}
