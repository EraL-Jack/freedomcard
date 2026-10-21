import { describe, expect, it } from 'vitest';

import { INTENTS, applyIntent, createInitialState, reduce } from '@app/core';
import { MULLIGAN_WINDOW_MS, RULE_ERRORS, TURN_TIMEOUT_MS } from '@app/shared/constants';
import type { CardDef, GameState, Intent, RuleContext } from '@app/shared/types';

import { buildMulliganSkipIntent, mulliganWindowMs, pendingMulliganPlayers } from './mulligan-timeout.js';

/**
 * D-267 / issue #99 的回归测试。
 *
 * ## 这条 bug 为什么必须用「跑一遍规则」来钉
 *
 * 原来的故障是**服务端超时兜底构造的 Intent 漏了 `payload.returns`**，
 * 引擎回「returns 必须是 uid 数组」，于是换牌阶段永远关不掉。
 *
 * 只断言「构造结果里有 payload」是不够的 —— 那只是形状检查，将来规则若改成
 * 认别的字段名，测试照样绿。所以这里直接把构造出的 Intent 丢进 `applyIntent`，
 * 断言**引擎真的接受**：红绿验证时把 `payload` 删掉，这条会立刻变红。
 */

/** 测试夹具卡池（与 `core/rules/rules.test.ts` 同风格：只求跑通规则，不追真实卡面）。 */
const CARDS: Record<string, CardDef> = {
  cmd: { defId: 'cmd', name: '指挥官', type: 'commander', cost: 0, power: 5 },
  m1: { defId: 'm1', name: '随从1', type: 'minion', cost: 1, power: 2 },
};
const DECK = [...Array<string>(30).fill('m1')];
const CTX: RuleContext = { now: 1_000, cards: CARDS };

/**
 * 造一个「已开局、停在换牌阶段」的状态。
 *
 * 不走 `start` Intent 的原因：`startRule` 要跑洗牌 / 发牌 / 掷骰，而这几条用例只关心
 * 换牌阶段本身（跳过与确认）。手牌留空也不影响 —— 「跳过」不抽牌。
 */
function mulliganState(): GameState {
  const s = createInitialState({
    seed: 1,
    seats: ['p1', 'p2'],
    decks: { p1: DECK, p2: DECK },
    commanders: { p1: 'cmd', p2: 'cmd' },
  });
  return { ...s, started: true, startedAt: 1_000, phase: 'mulligan' };
}

describe('D-267 换牌超时兜底的 Intent 构造', () => {
  it('带空数组 payload —— 引擎接受并记录「完成换牌」', () => {
    const s = mulliganState();

    const intent = buildMulliganSkipIntent('p1', 10);
    // 形状：缺 payload 正是 D-267 的原始故障
    expect(intent.payload).toEqual({ returns: [] });
    expect(intent.actor).toBe('system');

    const r = applyIntent(s, intent, CTX);
    expect(r.ok, '跳过必须被接受 —— 否则换牌阶段关不掉').toBe(true);
    if (r.ok) expect(r.value.some((e) => e.type === 'mulligan:done')).toBe(true);
  });

  it('双方都跳过 → 阶段关闭（「倒计时结束直接开局」的服务端保证）', () => {
    let s = mulliganState();
    for (const [i, pid] of (['p1', 'p2'] as const).entries()) {
      const r = applyIntent(s, buildMulliganSkipIntent(pid, 20 + i), CTX);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('unreachable');
      for (const ev of r.value) s = reduce(s, ev);
    }
    expect(s.players['p1']!.mulliganDone).toBe(true);
    expect(s.players['p2']!.mulliganDone).toBe(true);
    expect(s.phase).not.toBe('mulligan');
  });

  it('缺 payload 会被引擎拒（规则层不放宽 —— 否则同类 bug 永远查不出）', () => {
    const s = mulliganState();
    const broken: Intent = { type: INTENTS.mulligan, actor: 'system', playerId: 'p1', seq: 5 };
    const r = applyIntent(s, broken, CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(RULE_ERRORS.CARD_NOT_IN_ZONE);
  });
});

describe('D-267 pendingMulliganPlayers', () => {
  it('只列还没确认的人', () => {
    const s = mulliganState();
    expect(pendingMulliganPlayers(s).sort()).toEqual(['p1', 'p2']);

    const r = applyIntent(s, buildMulliganSkipIntent('p1', 3), CTX);
    if (!r.ok) throw new Error('unreachable');
    let s2 = s;
    for (const ev of r.value) s2 = reduce(s2, ev);
    expect(pendingMulliganPlayers(s2)).toEqual(['p2']);
  });

  it('不在换牌阶段时返回空数组（禁止对已开局/已结束的对局下黑手）', () => {
    const s = mulliganState();
    expect(pendingMulliganPlayers({ ...s, phase: 'main' })).toEqual([]);
    expect(pendingMulliganPlayers({ ...s, started: false })).toEqual([]);
  });
});

describe('D-267 mulliganWindowMs —— 换牌窗口跟随房间回合时限', () => {
  it('房间档位优先于默认值（Era：不要固定值）', () => {
    expect(mulliganWindowMs(180_000, MULLIGAN_WINDOW_MS)).toBe(180_000);
    expect(mulliganWindowMs(TURN_TIMEOUT_MS, MULLIGAN_WINDOW_MS)).toBe(TURN_TIMEOUT_MS);
  });

  it('档位缺失 / 非法时回落默认值（防御 0 与 NaN）', () => {
    expect(mulliganWindowMs(0, MULLIGAN_WINDOW_MS)).toBe(MULLIGAN_WINDOW_MS);
    expect(mulliganWindowMs(Number.NaN, MULLIGAN_WINDOW_MS)).toBe(MULLIGAN_WINDOW_MS);
  });
});
