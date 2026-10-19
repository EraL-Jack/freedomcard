/**
 * 规则处理器的公共原语 —— 不是规则，是被多条规则共用的底层操作。
 *
 * 放在这里是为了让「一个机制一个文件」能真正成立：如果每条规则各写一份
 * 「找卡 / 移动 / 抽牌」，后续的改动就会散落在多个文件里，违反
 * 「新增规则不得修改既有规则文件内部实现」的可达性前提。
 */

import type {
  CardDef,
  CardInstance,
  GameEvent,
  GameState,
  Intent,
  PlayerId,
  PlayerState,
  Rejection,
  Zone,
} from '@app/shared';
import {
  DAMAGE_TIER_MAX_LOW,
  DAMAGE_TIER_MAX_MID,
  MINION_COST_DISCOUNT,
  RULE_ERRORS,
} from '@app/shared';

import { advanceCursor, shuffle } from './rng.js';
import { ZONES, activePlayer } from './state.js';

/* ----------------------------- 事件构造器 ----------------------------- */

/** 构造事件。`at` 必须显式传入 —— core 内禁止读时钟，时间戳只来自 `ctx.now`。 */
export function ev(at: number, type: string, payload?: Record<string, unknown>): GameEvent {
  return payload === undefined ? { type, at } : { type, at, payload };
}

/** 区域间移动一张卡。**唯一的**改区手段，便于回放与审计。 */
export const moved = (at: number, playerId: PlayerId, uid: string, from: Zone, to: Zone): GameEvent =>
  ev(at, 'card:moved', { playerId, uid, from, to });

/** 随机游标推进 `steps` 步。洗牌结果由相邻事件显式携带，reducer 只需对齐游标。 */
export const rngAdvance = (at: number, steps: number): GameEvent => ev(at, 'rng:advance', { steps });

/** 卡组重排。`order` 是重排后的 uid 序列。 */
export const deckShuffled = (at: number, playerId: PlayerId, order: readonly string[]): GameEvent =>
  ev(at, 'deck:shuffled', { playerId, order: [...order] });

export const phaseChanged = (at: number, from: string, to: string): GameEvent =>
  ev(at, 'phase:changed', { from, to });

export const turnChanged = (at: number, turn: number, activeSeat: number): GameEvent =>
  ev(at, 'turn:changed', { turn, activeSeat });

export const maxCostChanged = (at: number, playerId: PlayerId, value: number): GameEvent =>
  ev(at, 'maxCost:changed', { playerId, value });

/* ------------------------------ 查询 ------------------------------ */

export interface Located {
  playerId: PlayerId;
  zone: Zone;
  index: number;
  card: CardInstance;
}

/** 全状态按 uid 定位一张卡。找不到返回 null。 */
export function locate(state: GameState, uid: string): Located | null {
  for (const id of state.seats) {
    const p = state.players[id];
    if (!p) continue;
    for (const zone of ZONES) {
      const list = p.zones[zone];
      const index = list.findIndex((c) => c.uid === uid);
      if (index >= 0) return { playerId: id, zone, index, card: list[index]! };
    }
  }
  return null;
}

/** 取玩家对象；座位表里没有则抛错（调用前应已校验）。 */
export function playerOf(state: GameState, playerId: PlayerId): PlayerState | null {
  return state.players[playerId] ?? null;
}

/**
 * 取卡定义。**查不到返回 undefined，调用方必须据此拒绝，不得默认按 0 处理。**
 *
 * 卡池缺失时若静默按 0 处理，会让一张本来很强的卡变成「谁都打得过」，
 * 且服务端与客户端都不会报错 —— 属于最难排查的一类假象。
 */
export function defOf(cards: Record<string, CardDef>, defId: string): CardDef | undefined {
  return cards[defId];
}

/** 是否含指定关键词。定义缺失同样返回 false（不抛错，关键词是可选的）。 */
export function hasKeyword(def: CardDef | undefined, keyword: string): boolean {
  return def?.keywords?.includes(keyword) ?? false;
}

/** 从 payload 取字符串。非字符串返回 null —— 外部输入不可信。 */
export function strArg(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 从 payload 取字符串数组。含非字符串元素则整体返回 null（不接受部分有效）。 */
export function strListArg(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string' || v.length === 0) return null;
    out.push(v);
  }
  return out;
}

/* ------------------------------ 力量值 ------------------------------ */

/**
 * 取指挥官的力量值曲线；**未定义则返回 null** —— 此时按定长 `power` 处理（不成长）。
 *
 * 只认 `type === 'commander'`：样例卡里曲线是指挥官专属机制，随从写曲线属于数据错误，
 * 这里按「没有曲线」处理而不是报错，是为了不让一张卡的数据问题炸掉整个对局。
 */
export function powerCurveOf(def: CardDef | undefined): readonly number[] | null {
  if (!def || def.type !== 'commander') return null;
  const curve = def.powerCurve;
  if (!curve || curve.length === 0) return null;
  return curve.every((v) => Number.isFinite(v)) ? curve : null;
}

/**
 * 指挥官在指定档位的力量值。
 *
 * **超出曲线末尾则取末档**（封顶，不循环）—— X-7 只给了四个值，没有第 5 档，
 * 循环回 0 会让满级指挥官突然归零，属于发明规则。
 */
export function commanderPowerAt(def: CardDef, index: number): number {
  const curve = powerCurveOf(def);
  if (!curve) return def.power;
  const i = Math.min(Math.max(index, 0), curve.length - 1);
  return curve[i] ?? def.power;
}

/**
 * 取一个场上单位的**当前**力量值；查不到卡定义返回 `null`（调用方必须据此拒绝）。
 *
 * 基础值一律取 `CardDef.power`，再叠加：
 *  - `tempPower`（本回合临时修正，ADR-0023 §3）；
 *  - **霜律寒域光环**（ADR-0025）：敌方处于冻结状态的随从 −1 力。
 * 力量值下限 0（docs/12 §5.3），不为负。
 *
 * ⚠️ **指挥官没有力量值**（docs/16 §6.2.1 / D-230）：它不参与任何力量比较，
 * 打脸固定 1 点。`powerCurve` 字段只作历史保留，这里**不再读取** ——
 * 读它就等于让「已取消的成长」偷偷复活。
 */
export function unitPower(state: GameState, cards: Record<string, CardDef>, uid: string): number | null {
  const loc = locate(state, uid);
  if (!loc) return null;
  const def = defOf(cards, loc.card.defId);
  if (!def) return null;
  const base = def.power;
  // ADR-0023 §3：本回合临时力量修正叠加在基础值上（统领 3 档 / 军师 / 队长 / 勇士 / 凤凰等）。
  let value = base + (loc.card.tempPower ?? 0);
  // ADR-0025：寒域光环 —— 对手场上有「霜律寒域」时，处于霜冻状态的本方随从 −1 力。
  if (loc.zone === 'board' && loc.card.frozen) {
    const foe = state.seats.find((id) => id !== loc.playerId);
    const foeSpells = foe ? (state.players[foe]?.zones.spell ?? []) : [];
    const domains = foeSpells.filter((c) => c.defId === 'frostDomain').length;
    if (domains > 0) value -= domains;
  }
  return Math.max(0, value);
}

/* ------------------------------ 费用与伤害 ------------------------------ */

/**
 * 一张卡**实际要支付的费用**（docs/16 §4 / §4.1）：
 * 随从减 1（最低 0），法术与设置法术按卡面值。
 */
export function costToPay(def: CardDef): number {
  if (def.type !== 'minion') return Math.max(0, def.cost);
  return Math.max(0, def.cost - MINION_COST_DISCOUNT);
}

/**
 * 打脸伤害（docs/16 §5.5）：
 *  - 卡面写了 `damage` → 以卡面为准（例外覆盖，§5.5 / §9 第 8 条）；
 *  - 否则按**攻击者力量**分档：1–3 → 1，4–6 → 2，7+ → 3。
 *
 * 注意：卡面没写时**不再**走 `DEFAULT_DAMAGE`（那是 15 血旧口径）；
 * `DEFAULT_DAMAGE` 保留给「需要默认值的极少数场景」与测试夹具。
 */
export function faceDamageOf(def: CardDef, attackerPower: number): number {
  if (typeof def.damage === 'number') return def.damage;
  if (attackerPower >= DAMAGE_TIER_MAX_MID + 1) return 3;
  if (attackerPower >= DAMAGE_TIER_MAX_LOW + 1) return 2;
  return 1;
}

/* ------------------------------ 拒绝 ------------------------------ */

export function reject(code: string, message: string): { ok: false; error: Rejection } {
  return { ok: false, error: { code, message } };
}

/**
 * 所有玩家 Intent 的共同前置校验。
 *
 * ⚠️ `NOT_YOUR_TURN` 这条依赖于「只有当前行动方能操作」的前提。
 * `docs/06` A4-3 说**可以在对手回合行动**（响应 / 打断），但该机制本身
 * 未定义（触发时机、可响应的动作范围都没有），故暂不开放；
 * 待 Era 给出响应规则后，这条守卫需要在响应型 Intent 上按白名单放开。
 */
export function baseGuard(state: GameState, intent: Intent): Rejection | null {
  if (!state.started) {
    return { code: RULE_ERRORS.NOT_STARTED, message: '对局尚未开始' };
  }
  if (state.winner !== null || state.draw) {
    return { code: RULE_ERRORS.GAME_OVER, message: '对局已结束' };
  }
  if (state.seats.length === 0) return { code: RULE_ERRORS.NOT_STARTED, message: '无座位' };
  if (intent.actor === 'player' && activePlayer(state) !== intent.playerId) {
    return { code: RULE_ERRORS.NOT_YOUR_TURN, message: '不是你的回合' };
  }
  return null;
}

/** 要求处于指定阶段。 */
export function phaseGuard(state: GameState, phase: string): Rejection | null {
  if (state.phase !== phase) {
    return { code: RULE_ERRORS.WRONG_PHASE, message: `当前阶段不是${phase}` };
  }
  return null;
}

/** 联合守卫：任一不通过即返回该拒绝。 */
export function firstRejection(...checks: (Rejection | null)[]): Rejection | null {
  for (const c of checks) if (c) return c;
  return null;
}

/* ------------------------------ 抽牌 ------------------------------ */

export interface DeckPiles {
  /** 卡组，顺序即牌序，`deck[0]` 为顶。 */
  deck: readonly CardInstance[];
  graveyard: readonly CardInstance[];
}

export interface DrawResult {
  events: GameEvent[];
  deck: CardInstance[];
  graveyard: CardInstance[];
  /** 实际取出的卡（可能少于 `n` —— 卡组与弃牌区都空时静默停止）。 */
  taken: CardInstance[];
}

/**
 * 从卡组顶取 `n` 张送往 `to` 区域。
 *
 * A9 补充 2：卡组用尽时把弃牌区全部洗回卡组再取。洗牌消耗随机，
 * 故同步产出 `rng:advance` —— 必须紧邻 `deck:shuffled`，否则回放时游标对不上。
 *
 * `to` 做成参数是因为**指挥官受伤要把卡送进费用区**（A5 补充 1）：
 * 与抽牌唯一的区别是目的地，洗牌逻辑完全一样，故不复制一份。
 *
 * 返回取完后的 `deck` / `graveyard` 与实际取出的 `taken`，供调用方继续推演
 * （如起手换牌的后续洗牌、指挥官受伤的展示计数）。
 *
 * `reveal = true` 时在每个 `card:moved` **之前**产出 `card:revealed` ——
 * 顺序有意义：界面要先「翻出来给双方看」，再「放进费用区」。
 */
export function takeFromDeck(
  at: number,
  playerId: PlayerId,
  piles: DeckPiles,
  n: number,
  cursor: number,
  to: Zone,
  reveal = false,
): DrawResult {
  let deck = piles.deck.slice();
  let graveyard = piles.graveyard.slice();
  let c = cursor;
  const events: GameEvent[] = [];
  const taken: CardInstance[] = [];

  for (let i = 0; i < n; i++) {
    if (deck.length === 0) {
      if (graveyard.length === 0) break; // 无牌可取 —— 规则未定义疲劳，故静默停止（A9-3：无疲劳）
      const steps = Math.max(0, graveyard.length - 1);
      const s = shuffle(c, graveyard);
      c = s.nextCursor;
      deck = s.items;
      graveyard = [];
      events.push(rngAdvance(at, steps));
      events.push(deckShuffled(at, playerId, deck.map((x) => x.uid)));
    }
    const card = deck.shift()!;
    taken.push(card);
    if (reveal) {
      events.push(ev(at, 'card:revealed', { playerId, uid: card.uid, from: 'deck', reason: 'commander-damage' }));
    }
    events.push(moved(at, playerId, card.uid, 'deck', to));
  }

  return { events, deck, graveyard, taken };
}

/**
 * 抽牌 = 从卡组顶取 `n` 张送往手牌。
 * 保留此名是因为抽牌是最高频的调用点，语义自明。
 */
export function drawCards(
  at: number,
  playerId: PlayerId,
  piles: DeckPiles,
  n: number,
  cursor: number,
): DrawResult {
  return takeFromDeck(at, playerId, piles, n, cursor, 'hand');
}

/* --------------------------- 本地推演辅助 --------------------------- */

/** 把一批事件就地应用到状态副本上（规则内部推演用，非 reducer 的公开入口）。 */
export function applyLocal(
  state: GameState,
  events: readonly GameEvent[],
  reduce: (s: GameState, e: GameEvent) => GameState,
): GameState {
  let s = state;
  for (const e of events) s = reduce(s, e);
  return s;
}

/** 供 reducer 使用的游标推进（避免 reducer 直接依赖 rng 细节）。 */
export { advanceCursor };
