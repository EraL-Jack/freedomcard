import { describe, expect, it } from 'vitest';

import {
  IntentSchema,
  ROOM_ERRORS,
  ROOM_ERROR_TEXT,
  RoomCreateSchema,
  RoomDeckSchema,
  RoomJoinSchema,
} from '@app/shared';

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
 * 在入站被静默丢弃，服务端只会看到「没带卡组」并回退默认 —— 没有任何报错。
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

  it('RoomDeckSchema：空数组合法（回到默认卡组），超过 30 张被拒', () => {
    expect(RoomDeckSchema.safeParse({ deck: [] }).success).toBe(true);
    expect(RoomDeckSchema.safeParse({ deck }).success).toBe(true);
    expect(
      RoomDeckSchema.safeParse({ deck: Array.from({ length: 31 }, () => 'bladeScout') }).success,
    ).toBe(false);
    expect(RoomDeckSchema.safeParse({}).success).toBe(false);
  });
});

/**
 * 房间入站 schema · 指挥官（D-184 / ADR-0042）。
 *
 * 「阵营」已删除，改成「卡组 + 指挥官」成对提交。这里钉两件事：
 * 1. `commander` **不被 strip** —— 同一个老坑（`payload`、`deck` 各踩过一次）；
 * 2. 老客户端仍带着 `faction` 时**不报错**，字段被静默丢掉即可（向后兼容）。
 */
describe('房间入站 schema · 指挥官（D-184）', () => {
  const deck = Array.from({ length: 30 }, () => 'bladeScout');

  it('三个入口都保留 commander', () => {
    expect(
      RoomCreateSchema.parse({ nickname: 'Era', capacity: 2, deck, commander: 'frostAdjudicator' })
        .commander,
    ).toBe('frostAdjudicator');
    expect(
      RoomJoinSchema.parse({ code: 'ABC123', nickname: 'Era', commander: 'starWatcher' }).commander,
    ).toBe('starWatcher');
    expect(RoomDeckSchema.parse({ deck, commander: 'bladeLord' }).commander).toBe('bladeLord');
  });

  it('不带 commander 仍合法（缺省由服务端补）', () => {
    expect(RoomCreateSchema.parse({ nickname: 'Era', capacity: 2 }).commander).toBeUndefined();
    expect(RoomDeckSchema.parse({ deck }).commander).toBeUndefined();
  });

  it('空字符串被拒 —— 空值不能当成「有指挥官」', () => {
    expect(RoomCreateSchema.safeParse({ nickname: 'Era', capacity: 2, commander: '' }).success).toBe(
      false,
    );
  });

  it('老客户端的 faction 字段被丢掉但不报错（删除阵营不破坏兼容）', () => {
    const parsed = RoomCreateSchema.parse({
      nickname: 'Era',
      capacity: 2,
      faction: 'frost',
      commander: 'bladeLord',
    });
    expect(parsed).not.toHaveProperty('faction');
    expect(parsed.commander).toBe('bladeLord');
  });

  /**
   * H18（Era 2026-10-21）：回合时限在建房时可选。
   *
   * 这条测试守的是那个老坑 —— `z.object()` 默认 strip 未声明的键：
   * 协议加了 `turnTimeoutMs` 但 schema 忘了声明，字段会被静默丢掉，
   * 玩家选 999 秒、服务端仍按默认 60 秒跑，界面上没有任何异常。
   */
  /*
   * #161：`opponentDeck` 必须**穿过 zod**。
   *
   * 这是本仓库踩过三次的坑（`payload` / `deck` / `commander`）：`z.object()` 会静默
   * strip 未声明的键，于是「客户端传了、服务端永远收不到」，界面看着正常、行为错。
   * 所以每个新增协议字段都要有一条「保留」断言。
   */
  it('RoomCreateSchema 保留 opponentDeck（人机房可选对手卡组 #161）', () => {
    expect(
      RoomCreateSchema.parse({ nickname: 'Era', capacity: 2, solo: true, opponentDeck: 'frost' })
        .opponentDeck,
    ).toBe('frost');
    // 缺省 = 不带该字段 → 房间层按房码散列（与加字段之前一致）
    expect(
      RoomCreateSchema.parse({ nickname: 'Era', capacity: 2, solo: true }).opponentDeck,
    ).toBeUndefined();
    // 非法 slug **能过 schema** —— 回落逻辑在房间层，不该让建房 400
    expect(
      RoomCreateSchema.safeParse({
        nickname: 'Era',
        capacity: 2,
        solo: true,
        opponentDeck: 'no-such-deck',
      }).success,
    ).toBe(true);
    // 类型层面仍挡明显越界（超长字符串）
    expect(
      RoomCreateSchema.safeParse({ nickname: 'Era', capacity: 2, opponentDeck: 'x'.repeat(17) })
        .success,
    ).toBe(false);
  });

  it('RoomCreateSchema 保留 turnTimeoutMs；非白名单档位在房间层回落（不报 400）', () => {
    expect(
      RoomCreateSchema.parse({ nickname: 'Era', capacity: 2, turnTimeoutMs: 180_000 }).turnTimeoutMs,
    ).toBe(180_000);
    // 缺省 = 不带该字段，房间层取默认值
    expect(RoomCreateSchema.parse({ nickname: 'Era', capacity: 2 }).turnTimeoutMs).toBeUndefined();
    // 类型层面只约束正整数：120000 这种未定义档位能过 schema（回落逻辑在 room.create）
    expect(
      RoomCreateSchema.parse({ nickname: 'Era', capacity: 2, turnTimeoutMs: 120_000 }).turnTimeoutMs,
    ).toBe(120_000);
    // 负数 / 非整数直接拒
    expect(
      RoomCreateSchema.safeParse({ nickname: 'Era', capacity: 2, turnTimeoutMs: -1 }).success,
    ).toBe(false);
    expect(
      RoomCreateSchema.safeParse({ nickname: 'Era', capacity: 2, turnTimeoutMs: 60_000.5 }).success,
    ).toBe(false);
  });
});

/**
 * 房间错误码文案覆盖（D-157）。
 *
 * 客户端原来自己维护一张映射表，把 `ROOM_NOT_FOUND` 写成了 `NOT_FOUND`、还缺 5 个码；
 * 现在表在 `shared`，用 `Record<RoomErrorCode, string>` 声明（少一条就编译报错）。
 * 这条测试钉运行时的那一半：每个码都要有中文文案，且不能只是把码抄一遍。
 */
describe('房间错误码 → 中文文案', () => {
  it('每个错误码都有文案，且不是错误码本身', () => {
    for (const code of Object.values(ROOM_ERRORS)) {
      const text = ROOM_ERROR_TEXT[code];
      expect(text, code).toBeTruthy();
      expect(text, code).not.toBe(code);
      expect(/[一-龥]/.test(text), code).toBe(true);
    }
  });
});
