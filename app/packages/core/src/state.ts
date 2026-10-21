import type { CardInstance, GameState, PlayerId, PlayerState, Zone } from '@app/shared/types';
import { INITIAL_COMMANDER_POWER_INDEX, INITIAL_HEALTH, INITIAL_MAX_COST } from '@app/shared/constants';

import { initialRngCursor } from './rng.js';

/**
 * 对局状态的构造与不可变更新 —— 结构见 ADR-0012。
 *
 * 这里只做「结构层面」的初始化，**不含任何规则判断**（洗牌、发牌、掷骰属于规则，
 * 分别在各自的 handler 里）。理由是：开局流程还没跑，状态就该是确定的初始形，
 * 便于单测与回放从同一起点出发。
 */

/**
 * 9 个区域，与 `docs/06` B2 布局逐项对应（无独立充能区 —— Era 2026-10-13 确认）。
 *
 * `reveal`（展示区）是**瞬时**区域：卡在效果结算期间停在这里，结算完回牌库底。
 * 放在数组末尾，`locate` 这类「按顺序找第一处」的查找才不会被它抢先命中。
 */
export const ZONES: readonly Zone[] = [
  'deck',
  'hand',
  'commander',
  'board',
  'spell',
  'cost',
  'graveyard',
  'exile',
  'reveal',
];

export function emptyZones(): Record<Zone, CardInstance[]> {
  const zones = {} as Record<Zone, CardInstance[]>;
  for (const z of ZONES) zones[z] = [];
  return zones;
}

/**
 * 卡实例 uid。
 *
 * 必须**确定性生成** —— 用 `玩家#序号` 而非随机 id：随机 uid 会进 `stateHash`，
 * 导致两次回放（或服务端与客户端各算一次）得到不同哈希，属于隐蔽的假 desync。
 */
export function makeUid(playerId: PlayerId, index: number): string {
  return `${playerId}#${index}`;
}

/**
 * 指挥官实例的 uid。
 * 单独命名而不是复用 `makeUid(id, 'cmd')`：指挥官不进主卡组，没有序号，
 * 混用会让人误以为它是「第 cmd 张卡」。
 */
export function commanderUid(playerId: PlayerId): string {
  return `${playerId}#commander`;
}

export interface InitialStateOptions {
  seed: number;
  /**
   * 开局随机游标（可选）—— D-269。
   *
   * 生产开局不传：由 `seed` 经 `initialRngCursor` 派生。
   * 传的场景只有一个：**回放重建**。回放文件里记着当时的游标，
   * 显式用它才能保证「记录怎么写的、就怎么重跑」，把「派生算法」这件事
   * 与历史文件解耦（换算法不该让旧文件失效）。
   */
  rngCursor?: number;
  /** 座位顺序，由调用方给出（先后手在此之后由掷骰决定，见 A2-4）。 */
  seats: readonly PlayerId[];
  /**
   * 每位玩家的**主卡组** —— `defId` 列表，顺序即初始牌序（洗牌在开局时做）。
   * ADR-0012 补充：主卡组 30 张，**不含指挥官**。
   */
  decks: Record<PlayerId, readonly string[]>;
  /** 每位玩家的指挥官 `defId`。ADR-0012 补充：指挥官有且仅有 1 张，不进主卡组。 */
  commanders: Record<PlayerId, string>;
}

export function createInitialState(opts: InitialStateOptions): GameState {
  const players: Record<PlayerId, PlayerState> = {};
  for (const id of opts.seats) {
    const deck = (opts.decks[id] ?? []).map((defId, i) => ({ uid: makeUid(id, i), defId }));
    players[id] = {
      id,
      commanderDefId: opts.commanders[id] ?? '',
      health: INITIAL_HEALTH,
      maxCost: INITIAL_MAX_COST,
      zones: { ...emptyZones(), deck },
      commanderRevealed: false,
      commanderPowerIndex: INITIAL_COMMANDER_POWER_INDEX,
      mulliganDone: false,
      firstChargeAt: null,
      chargeCount: 0,
      effectsUsed: [],
      turnTriggers: [],
      usedCostThisTurn: 0,
      commanderAttacked: false,
      // 成长资源（D-229 / D-230）—— 永久累积，回合切换不清零。
      frostMark: 0,
      starTrack: 0,
      // 回合级临时修正 —— `turn:changed` 清零。
      commanderDamageBonus: 0,
      nextMinionDiscount: 0,
      tokenSeq: 0,
    };
  }
  return {
    /*
     * 初值必须由 seed 派生 —— D-269 / issue #103。
     *
     * 这里原来是写死的 `0`，于是 `seed` 只是被存进 state 供回放记录，
     * **一次都没参与随机**：开局洗牌永远从同一游标出发 → 每局牌序、先后手完全相同。
     * Era 的原话是「每次进游戏都是固定起手，没洗牌吗」—— 洗了，但洗的是同一副。
     *
     * 用 `seedFrom` 而不是直接拿 `seed >>> 0` 当游标：FNV-1a 会把「相邻的种子」
     * （`Date.now()` 相差几毫秒的那种）打散成彼此无关的游标，避免相邻种子洗出相近牌序；
     * 同时 seed=0 也不会退化成原来的常量 0。
     */
    rngCursor: opts.rngCursor ?? initialRngCursor(opts.seed),
    seed: opts.seed,
    players,
    seats: [...opts.seats],
    activeSeat: 0,
    phase: 'charge',
    drawnThisPhase: false,
    turn: 1,
    started: false,
    startedAt: null,
    winner: null,
    draw: false,
    endReason: null,
    suddenDeath: false,
    pendingChoice: null,
    pendingChoiceQueue: [],
  };
}

/** 取当前行动方。座位表为空时返回 null（未开局）。 */
export function activePlayer(state: GameState): PlayerId | null {
  return state.seats[state.activeSeat] ?? null;
}

/** 取对手（2 人对战）。座位表异常时返回 null。 */
export function opponentOf(state: GameState, playerId: PlayerId): PlayerId | null {
  return state.seats.find((id) => id !== playerId) ?? null;
}
