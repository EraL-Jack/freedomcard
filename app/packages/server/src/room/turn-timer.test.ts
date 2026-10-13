import { describe, expect, it } from 'vitest';

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
    expect(timer(s).t.timeoutMs).toBe(30_000);
  });

  it('未到时限不触发', () => {
    const s = fakeScheduler();
    const { t, fired } = timer(s);
    t.arm();
    s.advance(29_999);
    expect(fired()).toBe(0);
    expect(t.armed).toBe(true);
  });

  it('到达时限触发一次，并自动解除 armed', () => {
    const s = fakeScheduler();
    const { t, fired } = timer(s);
    t.arm();
    s.advance(30_000);
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
    s.advance(29_999);
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
    s.advance(60_000);
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
