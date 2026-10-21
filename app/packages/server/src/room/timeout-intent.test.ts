import { describe, expect, it } from 'vitest';

import { applyIntent, reduce } from '@app/core';

import { CARD_POOL } from '../cards.js';
import { seedGameState } from './session.js';
import { buildTimeoutIntent } from './timeout-intent.js';

/**
 * 超时兜底的接线自检（T-05 / ADR-0017）。
 *
 * ## 为什么需要这条
 *
 * `docs/21` T-05 指出：`handleTurnTimeout` 从来没被任何测试执行过 ——
 * 它是「30 秒不动就自动结束回合」这条规则的唯一实现，却长期零覆盖。
 * 一旦 `turn:end` 的 Intent 形状写错（少 `actor: 'system'`、`playerId` 写成对手），
 * 表现是「超时后回合原地不动」，而且只有真等满 60 秒才会发现。
 *
 * ## 覆盖到哪
 *
 * 从「构造 Intent」一路跑到 `applyIntent` + `reduce`：回合真的推进了。
 * 不覆盖的只有 socket 广播，那部分由 E2E（多人开局用例）兜着。
 */

const SEATS = ['p1', 'p2'];

function startedState() {
  const state = seedGameState({ seats: SEATS, seed: 7 });
  // 走一遍开局：掷骰 / 洗牌 / 发起手都由引擎产出，超时只能发生在已开局的状态上
  const ctx = { now: 1_000, cards: CARD_POOL };
  const start = applyIntent(
    state,
    { type: 'game:start', actor: 'system', playerId: SEATS[0]!, seq: 1 },
    ctx,
  );
  if (!start.ok) throw new Error(`开局被拒：${start.error.code}`);
  return start.value.reduce((s, e) => reduce(s, e), state);
}

describe('超时兜底 Intent（T-05）', () => {
  it('未开局（没有座位）时不给 Intent —— 没有「该超时的人」', () => {
    const empty = seedGameState({ seats: [], seed: 1 });
    expect(buildTimeoutIntent(empty, 0)).toBeNull();
  });

  it('已开局：系统 Intent、指向当前行动方、成因 timeout', () => {
    const s = startedState();
    const active = s.seats[s.activeSeat]!;
    const intent = buildTimeoutIntent(s, 41);
    expect(intent).not.toBeNull();
    expect(intent!.type).toBe('turn:end');
    // ⚠️ 必须是 system：否则 `baseGuard` 会按玩家守卫拦掉（不是自己的回合就拒绝）
    expect(intent!.actor).toBe('system');
    expect(intent!.playerId).toBe(active);
    expect(intent!.reason).toBe('timeout');
    // seq 与玩家 Intent 共用一个序列空间，必须接着服务端序号往上走
    expect(intent!.seq).toBe(42);
  });

  it('交给引擎后回合真的推进了（这才是「超时生效」的证据）', () => {
    const s = startedState();
    const turnBefore = s.turn;
    const intent = buildTimeoutIntent(s, 0)!;
    const out = applyIntent(s, intent, { now: 2_000, cards: CARD_POOL });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const after = out.value.reduce((acc, e) => reduce(acc, e), s);
    // turn:end 会把剩余阶段逐个推完并进入下一回合
    expect(after.turn).toBe(turnBefore + 1);
    // 行动方换人 —— 否则「超时」只是原地重开了同一回合
    expect(after.activeSeat).not.toBe(s.activeSeat);
    // 事件流里必须有一条 turn:changed 供客户端渲染横幅
    expect(out.value.some((e) => e.type === 'turn:changed')).toBe(true);
  });

  it('已结束的对局不再产生超时 Intent —— 定时器晚一拍也不该把回合推走', () => {
    const s = startedState();
    // 两种结束形态都要挡住：有胜者 / 判和
    expect(buildTimeoutIntent({ ...s, winner: s.seats[0]!, endReason: 'health' }, 0)).toBeNull();
    expect(buildTimeoutIntent({ ...s, draw: true, endReason: 'draw' }, 0)).toBeNull();
  });
});
