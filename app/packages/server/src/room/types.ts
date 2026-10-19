import type { Faction, MatchFormat, PlayerId } from '@app/shared';
import type { RoomErrorCode } from '@app/shared/constants';

/**
 * 房间与席位 —— **只描述传输层事实**，不含任何玩法字段。
 *
 * 房间容量、胜负、回合等一概不在此定义：容量由建房方传入（Era 未定人数，不预设 2），
 * 玩法字段等 `docs/06` A 组输入后进入 `GameState`。
 *
 * ⚠️ 例外是**赛制与系列赛比分**（D-132）：它们跨越多局 `GameState`，
 * 天然不属于单局状态，故落在房间层。单局规则（血量 / 回合 / 胜负）仍在引擎里。
 */

export type RoomPhase = 'lobby' | 'playing' | 'ended';

/** 一个席位。`null` 表示空位。 */
export interface Seat {
  seat: number;
  playerId: PlayerId;
  nickname: string;
  /** 重连凭据：断线后凭此恢复席位。 */
  token: string;
  connected: boolean;
  /** 服务端已处理的最大 seq —— 重连时下发给客户端，客户端从 `lastSeq + 1` 续发。 */
  lastSeq: number;
  disconnectedAt: number | null;
  /**
   * 是否已准备 —— B1 补充 3「双方加入并准备后即开始游戏」+ ADR-0019。
   *
   * 属于**房间层事实**（玩家的操作意愿），不是玩法状态，故放在这里而非 `GameState`。
   */
  ready: boolean;
  /**
   * 阵营（D-235）—— 建房 / 加入时由玩家选择，决定这一席位的 30 张主卡组与指挥官。
   * 缺省时由服务端按座位轮换（老客户端不带该字段也要能用）。
   */
  faction: Faction;
  /**
   * 自建主卡组（D-141）—— 30 个 `defId`，入站已用 `validateDeckList` 校验过。
   *
   * `undefined` = 使用阵营默认卡组（客户端提交空数组等价于回到默认）。
   * 只在未开局时可改，开局后锁定（`DECK_LOCKED`）。
   * 指挥官**始终**由阵营决定，`deck` 只覆盖主卡组那 30 张。
   */
  deck?: readonly string[];
}

export interface Room {
  id: string;
  code: string;
  phase: RoomPhase;
  capacity: number;
  hostId: PlayerId;
  seats: (Seat | null)[];
  createdAt: number;
  /**
   * 赛制 —— BO1 单局 / BO3 三局两胜（D-132）。
   *
   * docs/16 §1.3：先手胜率约 56.5%，不靠规则继续压，改用「BO3 双方各先手一次」消化。
   */
  format: MatchFormat;
  /** 系列赛比分。键只包含在座玩家。 */
  wins: Record<PlayerId, number>;
  /** 已完成的小局数（0 = 一局都没打完）。 */
  gameNo: number;
  /** 上一小局已结束、系列赛未分胜负 —— 等待房主开始下一小局。 */
  awaitingNext: boolean;
  /** 系列赛胜者（拿满 2 胜 / 对手离场）。未分胜负为 null。 */
  seriesWinner: PlayerId | null;
  /**
   * 每小局的先手玩家（按局序）—— BO3「双方各先手一次」的依据（docs/16 §1.3）。
   *
   * 第 2 小局强制由第 1 小局的后手先攻；第 3 小局重新掷骰。
   */
  firstPlayers: PlayerId[];
}

export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: RoomErrorCode; message: string };

/** 注入时钟 —— 让全部超时逻辑可单测（core 内禁止读时钟，会话层可以，但要可注入）。 */
export interface Clock {
  now(): number;
}

/** 注入 ID 生成器 —— 房间码 / playerId / token，便于测试固定值。 */
export interface IdGen {
  id(): string;
  token(): string;
  code(): string;
}
