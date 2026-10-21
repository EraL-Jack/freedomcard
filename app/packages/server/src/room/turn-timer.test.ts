import { describe, expect, it } from 'vitest';

import { TURN_TIMEOUT_MS } from '@app/shared/constants';

import { TurnTimer, type Scheduler } from './turn-timer.js';

/**
 * 假调度器 —— 手动推进时间。
 *
 * 用注入的假调度器而不是框架自带的 fake timers，是为了让「定时器是否叠加」这一点
 * 直接可观测：`pending` 里剩几个回调，就是几个还活着的定时器。
 */
function fakeScheduler() {
  let now = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const scheduler: Scheduler = {
    setTimeout(fn, ms) {
      const id = ++seq;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    scheduler,
    get now() {
      return now;
    },
    /** 待触发的定时器数量。 */
    get pendingCount() {
      return pending.size;
    },
    /** 推进 `ms` 毫秒；到期回调按到期时刻升序触发，保证顺序确定。 */
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, v]) => v.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, v] = due;
        pending.delete(id);
        now = v.at;
        v.fn();
      }
      now = target;
    },
  };
}

function timer(s: ReturnType<typeof fakeScheduler>, timeoutMs?: number) {
  let fired = 0;
  const t = new TurnTimer({
    now: () => s.now,
    scheduler: s.scheduler,
    onTimeout: () => (fired += 1),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { t, fired: () => fired };
}

describe('回合超时调度（ADR-0017）', () => {
  it('默认时限取架构常量 TURN_TIMEOUT_MS', () => {
    const s = fakeScheduler();
    // ⚠️ 断言「等于常量」而不是写死 30_000：H18 把默认值从 30s 改成 60s 时，
    // 写死的断言会失败，但这**不是**缺陷 —— 这条测试要守的是「默认值来自常量」。
    expect(timer(s).t.timeoutMs).toBe(TURN_TIMEOUT_MS);
  });

  it('未到时限不触发', () => {
    const s = fakeScheduler();
    const { t, fired } = timer(s);
    t.arm();
    s.advance(t.timeoutMs - 1);
    expect(fired()).toBe(0);
    expect(t.armed).toBe(true);
  });

  it('到达时限触发一次，并自动解除 armed', () => {
    const s = fakeScheduler();
    const { t, fired } = timer(s);
    t.arm();
    s.advance(t.timeoutMs);
    expect(fired()).toBe(1);
    // 触发后不自动续命 —— 由会话层决定是否 arm 下一回合
    expect(t.armed).toBe(false);
  });

  it('重复 arm 不叠加 —— 一个回合只触发一次', () => {
    const s = fakeScheduler();
    const { t, fired } = timer(s);
    t.arm();
    s.advance(10_000);
    t.arm(); // 期间有操作 → 重新计时
    expect(s.pendingCount).toBe(1); // 旧的已被清掉，只剩新的
    s.advance(t.timeoutMs - 1);
    expect(fired()).toBe(0);
    s.advance(1);
    expect(fired()).toBe(1);
  });

  it('clear 后不再触发', () => {
    const s = fakeScheduler();
    const { t, fired } = timer(s);
    t.arm();
    t.clear();
    expect(s.pendingCount).toBe(0);
    s.advance(t.timeoutMs * 2);
    expect(fired()).toBe(0);
    expect(t.armed).toBe(false);
    expect(t.deadlineAt).toBe(0);
  });

  it('deadlineAt = 当前时刻 + 时限', () => {
    const s = fakeScheduler();
    const { t } = timer(s, 5_000);
    expect(t.deadlineAt).toBe(0);
    t.arm();
    expect(t.deadlineAt).toBe(5_000);
  });
});

/**
 * H18（Era 2026-10-21：回合时长在建房可选 30 / 60 / 180 / 999 秒）。
 *
 * 时限现在**跟着房间走**，所以 `TurnTimer` 必须能在建房时被改一次。
 * 这两条盯的是「改了要真的生效」与「计时中不许改」——后者不是洁癖：
 * 中途改时限会让当前回合的截止时刻莫名跳动，或只对下一回合生效，玩家看到的就是不确定。
 */
describe('回合时限按房间设置（H18）', () => {
  it('setTimeoutMs 后按新时限触发', () => {
    const s = fakeScheduler();
    const { t, fired } = timer(s);
    expect(t.timeoutMs).toBe(TURN_TIMEOUT_MS);
    t.setTimeoutMs(999_000);
    t.arm();
    expect(t.deadlineAt).toBe(999_000);
    s.advance(998_999);
    expect(fired()).toBe(0);
    s.advance(1);
    expect(fired()).toBe(1);
  });

  it('计时中改时限直接报错（建房之后没有任何合法调用点）', () => {
    const s = fakeScheduler();
    const { t } = timer(s);
    t.arm();
    expect(() => t.setTimeoutMs(180_000)).toThrow();
    // 报错不该留下半改状态：时限仍是原值，计时仍在走
    expect(t.timeoutMs).toBe(TURN_TIMEOUT_MS);
    expect(t.armed).toBe(true);
  });
});
