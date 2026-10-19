import { z } from 'zod';

/**
 * 传输层校验 schema。
 *
 * ⚠️ 运行时 `.parse()` 只允许在 **server 入站处** 调用。
 * client 侧只允许 `import type`，禁止引入 zod 做运行时校验 —— 实测仅引入一个
 * `z.object` 就会把首屏产物推到 gzip 24.17 kB，而客户端校验的是自己刚发出去的数据，没有收益。
 */

export const PlayerIdSchema = z.string().min(1);

export const IntentSchema = z.object({
  type: z.string().min(1),
  actor: z.enum(['player', 'system']),
  playerId: PlayerIdSchema,
  seq: z.number().int().nonnegative(),
  reason: z.string().min(1).optional(),
  /**
   * Intent 参数 —— **必须显式声明，不能依赖 passthrough**。
   *
   * ⚠️ `z.object()` 默认 **strip**（静默丢弃）未声明的键。漏掉这一行，
   * 所有带参数的 Intent —— 充能 `uids`、出牌 `uid`、攻击 `attackerUid`，
   * 换牌 `returns` —— 都会在传输层被剥掉参数，引擎侧只看到「缺少参数」。
   *
   * 单测直接构造 Intent 对象、不走 `.parse()`，**因此测不出这个问题**；
   * 它只在真实联机链路上暴露（2026-10-13 由 E2E 发现：点充能返回「uids 必须是 uid 数组」）。
   */
  payload: z.record(z.string(), z.unknown()).optional(),
});

export const EchoSchema = z.object({
  message: z.string(),
});

/**
 * 阵营与赛制 —— 建房 / 加入时由玩家选择（D-132 / D-235）。
 *
 * 值是**协议的一部分**：客户端与服务端都按这三个字符串通信，改动等于改协议。
 */
export const FactionSchema = z.enum(['blade', 'frost', 'star']);
export const MatchFormatSchema = z.enum(['bo1', 'bo3']);

/**
 * 房间入站 payload。
 * `capacity` 由客户端传入 —— 项目**不预设人数**（A 组未定），因此这里没有默认值兜底。
 *
 * `format` / `faction` 缺省时由服务端取默认值（BO1 / 按座位轮换阵营）：
 * 老客户端不带这两个字段也要能建房，故用 `optional()` 而不是必填。
 */
export const RoomCreateSchema = z.object({
  nickname: z.string().min(1).max(24),
  capacity: z.number().int().min(1).max(8),
  format: MatchFormatSchema.optional(),
  faction: FactionSchema.optional(),
});

export const RoomJoinSchema = z.object({
  code: z.string().min(1),
  nickname: z.string().min(1).max(24),
  faction: FactionSchema.optional(),
});

export const RoomReconnectSchema = z.object({
  playerId: PlayerIdSchema,
  token: z.string().min(1),
});

export type EchoPayload = z.infer<typeof EchoSchema>;

/** 服务端 /health 响应。 */
export const HealthSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
});
