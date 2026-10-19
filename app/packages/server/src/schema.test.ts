import { describe, expect, it } from 'vitest';

import { IntentSchema, RoomCreateSchema, RoomDeckSchema, RoomJoinSchema } from '@app/shared';

/**
 * 传输层 Intent 校验自检。
 *
 * 要钉住的是 **`payload` 必须原样穿过 `.parse()`** 这一条：
 * `z.object()` 默认 strip 未声明的键，一旦 `IntentSchema` 漏声明 `payload`，
 * 所有带参数的 Intent（充能 / 出牌 / 攻击 / 换牌）都会在入站处被静默剥掉参数。
 *
 * ⚠️ 这个 bug 单测**测不出来** —— 规则层单测直接构造 Intent 对象，不走 `.parse()`；
 * 它只在真实联机链路上暴露，第一次是被 E2E 抓到的（点充能返回「uids 必须是 uid 数组」）。
 * 故在此用**针对传输层**的用例永久钉住。
 */
describe('IntentSchema 传输层校验', () => {
  const base = {
    type: 'charge',
    actor: 'player',
    playerId: 'p1',
    seq: 1,
  } as const;

  it('带 payload 的 Intent 解析后参数完好', () => {
    const parsed = IntentSchema.parse({ ...base, payload: { uids: ['a#1', 'a#2'] } });
    expect(parsed.payload).toEqual({ uids: ['a#1', 'a#2'] });
  });

  it('不带 payload 的 Intent 仍可通过（可选字段）', () => {
    const parsed = IntentSchema.parse({ ...base });
    expect(parsed.payload).toBeUndefined();
  });

  it('payload 里的嵌套结构不被剥离', () => {
    const parsed = IntentSchema.parse({
      ...base,
      payload: { uid: 'a#1', nested: { x: 1 }, list: [1, 2] },
    });
    expect(parsed.payload).toEqual({ uid: 'a#1', nested: { x: 1 }, list: [1, 2] });
  });

  it('缺必填字段时拒绝', () => {
    expect(IntentSchema.safeParse({ type: 'charge' }).success).toBe(false);
  });

  it('seq 为负数或非整数时拒绝', () => {
    expect(IntentSchema.safeParse({ ...base, seq: -1 }).success).toBe(false);
    expect(IntentSchema.safeParse({ ...base, seq: 1.5 }).success).toBe(false);
  });
});

/**
 * 房间入站 schema · 自建卡组（D-141）。
 *
 * 与 `payload` 同理：`z.object()` 默认 strip，漏声明 `deck` 会让客户端提交的 30 张
 * 在入站被静默丢弃，服务端只会看到「没带卡组」并回退阵营默认 —— 没有任何报错。
 * 这类问题只能在传输层钉住。
 */
describe('房间入站 schema · 自建卡组（D-141）', () => {
  const deck = Array.from({ length: 30 }, () => 'bladeScout');

  it('RoomCreateSchema 保留 deck', () => {
    const parsed = RoomCreateSchema.parse({ nickname: 'Era', capacity: 2, deck });
    expect(parsed.deck).toHaveLength(30);
    expect(parsed.deck?.[0]).toBe('bladeScout');
  });

  it('RoomJoinSchema 保留 deck', () => {
    const parsed = RoomJoinSchema.parse({ code: 'ABC123', nickname: 'Era', deck });
    expect(parsed.deck).toHaveLength(30);
  });

  it('RoomDeckSchema：空数组合法（回到阵营默认），超过 30 张被拒', () => {
    expect(RoomDeckSchema.safeParse({ deck: [] }).success).toBe(true);
    expect(RoomDeckSchema.safeParse({ deck }).success).toBe(true);
    expect(
      RoomDeckSchema.safeParse({ deck: Array.from({ length: 31 }, () => 'bladeScout') }).success,
    ).toBe(false);
    expect(RoomDeckSchema.safeParse({}).success).toBe(false);
  });
});
