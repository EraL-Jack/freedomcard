import { describe, expect, it } from 'vitest';

import { WindowRateLimit } from './rate-limit.js';

function harness(limit: number, windowMs: number, start = 1_000_000) {
  const clock = { t: start };
  const rl = new WindowRateLimit({ limit, windowMs, now: () => clock.t });
  return { rl, advance: (ms: number) => (clock.t += ms) };
}

describe('WindowRateLimit · 固定窗口', () => {
  it('前 limit 次放行，第 limit+1 次被拒并给出剩余等待时间', () => {
    const { rl, advance } = harness(3, 60_000);
    expect(rl.take('a').ok).toBe(true);
    advance(1_000);
    expect(rl.take('a').ok).toBe(true);
    advance(1_000);
    expect(rl.take('a').ok).toBe(true);
    advance(1_000);

    const denied = rl.take('a');
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    // 窗口还剩 60 - 3 = 57 秒
    expect(denied.retryAfterMs).toBe(57_000);
  });

  it('窗口过去后配额恢复', () => {
    const { rl, advance } = harness(1, 1_000);
    expect(rl.take('a').ok).toBe(true);
    expect(rl.take('a').ok).toBe(false);
    advance(1_000);
    expect(rl.take('a').ok).toBe(true);
  });

  it('不同 key 互不影响（一条连接被限不会连累别人）', () => {
    const { rl } = harness(1, 60_000);
    expect(rl.take('a').ok).toBe(true);
    expect(rl.take('a').ok).toBe(false);
    expect(rl.take('b').ok).toBe(true);
  });

  it('forget 后重新计数，且不残留 key', () => {
    const { rl } = harness(2, 60_000);
    rl.take('a');
    rl.take('a');
    expect(rl.take('a').ok).toBe(false);
    expect(rl.size).toBe(1);

    rl.forget('a');
    expect(rl.size).toBe(0);
    expect(rl.take('a').ok).toBe(true);
  });

  it('retryAfterMs 至少为 1（不会返回 0 让界面显示「请等 0 秒」）', () => {
    const { rl, advance } = harness(1, 1_000);
    rl.take('a');
    advance(999);
    const denied = rl.take('a');
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.retryAfterMs).toBe(1);
  });
});
