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
});

export const EchoSchema = z.object({
  message: z.string(),
});

export type EchoPayload = z.infer<typeof EchoSchema>;

/** 服务端 /health 响应。 */
export const HealthSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
});
