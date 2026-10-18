import type { CardInstance, GameState, PlayerId, PlayerState, Zone } from '@app/shared';
import { INITIAL_COMMANDER_POWER_INDEX, INITIAL_HEALTH, INITIAL_MAX_COST } from '@app/shared';

/**
 * 对局状态的构造与不可变更新 —— 结构见 ADR-0012。
 *
 * 这里只做「结构层面」的初始化，**不含任何规则判断**（洗牌、发牌、掷骰属于规则，
 * 分别在各自的 handler 里）。理由是：开局流程还没跑，状态就该是确定的初始形，
 * 便于单测与回放从同一起点出发。
 */

/** 8 个区域，与 `docs/06` B2 布局逐项对应（无独立充能区 —— Era 2026-10-13 确认）。 */
export const ZONES: readonly Zone[] = [
  'deck',
  'hand',
  'commander',
  'board',
  'spell',
  'cost',
  'graveyard',
  'exile',
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
      effectsUsed: [],
      turnTriggers: [],
    };
  }
  return {
    rngCursor: 0,
    seed: opts.seed,
    players,
    seats: [...opts.seats],
    activeSeat: 0,
    phase: 'charge',
    drawnThisPhase: false,
    turn: 1,
    started: false,
    winner: null,
    pendingChoice: null,
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
