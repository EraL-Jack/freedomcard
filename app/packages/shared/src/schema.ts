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
 * 赛制 —— 建房时由玩家选择（D-132）。
 *
 * 值是**协议的一部分**：客户端与服务端都按这两个字符串通信，改动等于改协议。
 */
export const MatchFormatSchema = z.enum(['bo1', 'bo3']);

/**
 * 房间入站 payload。
 * `capacity` 由客户端传入 —— 项目**不预设人数**（A 组未定），因此这里没有默认值兜底。
 *
 * `format` / `commander` 缺省时由服务端取默认值（BO1 / 基础卡组自带的指挥官）：
 * 老客户端不带这两个字段也要能建房，故用 `optional()` 而不是必填。
 *
 * ⚠️ **D-184 / ADR-0042**：`faction` 已删除 —— Era 定的规则里没有阵营，卡池可以混选。
 * 老客户端仍可能带 `faction`，`z.object()` 会 strip 掉，不会 400（协议向后兼容）。
 */
/**
 * 自建主卡组 —— 30 个 `defId`（D-141）。
 *
 * ⚠️ 同样必须**显式声明**：`z.object()` 对未声明键是 strip，漏掉会让客户端提交的卡组
 * 在入站被静默丢弃，服务端只会看到「没带卡组」并回退默认 —— 这种失败没有任何报错。
 *
 * 这里只限制「字符串数组、长度不超过 30」；张数 / 同名上限 / 含指挥官 / 未知卡
 * 由服务端 `validateDeckList` 给出人话原因。
 */
const DeckSchema = z.array(z.string().min(1)).max(30);

/**
 * 指挥官 `defId`（D-184）—— 与主卡组**成对**提交。
 *
 * 只校验「非空短字符串」；是否真的存在、是不是指挥官类型，由服务端
 * `validateCommander` 给出人话原因（和卡组校验同一层，便于统一报错）。
 */
const CommanderSchema = z.string().min(1).max(64);

export const RoomCreateSchema = z.object({
  nickname: z.string().min(1).max(24),
  capacity: z.number().int().min(1).max(8),
  format: MatchFormatSchema.optional(),
  /**
   * **人机房**（D-242，Era 2026-10-21）—— 建房后由服务端自动占一个 AI 席位，
   * 房间立刻变成「我 + 电脑」，不需要第二个窗口。
   *
   * 缺省 `false`：老客户端不带该字段，行为不变（纯双人房）。
   * 为 `true` 时 `capacity` 被服务端强制为 2 —— 规则只验证过 2 人，
   * 让人机房开放 3~8 席等于造一个跑不通的房间。
   */
  solo: z.boolean().optional(),
  /** 本局的 30 张主卡组 —— 空/缺省 = 用服务端默认卡组。 */
  deck: DeckSchema.optional(),
  /** 本局的指挥官 —— 缺省 = 由所选卡组决定（基础卡组自带一位）。 */
  commander: CommanderSchema.optional(),
});

export const RoomJoinSchema = z.object({
  code: z.string().min(1),
  nickname: z.string().min(1).max(24),
  deck: DeckSchema.optional(),
  commander: CommanderSchema.optional(),
});

/**
 * 换卡组（准备页）—— 卡组与指挥官一起换，空数组表示回到服务端默认卡组。
 *
 * ⚠️ `commander` 必须在这里**显式声明**（D-184）。漏了就是那个老坑：
 * 客户端改了指挥官、服务端 strip 掉、继续用旧的，界面显示 A 卡组 A 指挥官、
 * 实际开局是 B —— 没有任何报错，只有打到一半发现技能不对。
 */
export const RoomDeckSchema = z.object({
  deck: DeckSchema,
  commander: CommanderSchema.optional(),
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
