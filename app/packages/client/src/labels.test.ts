import { describe, expect, it } from 'vitest';

import { endReasonText, turnTimeoutLabel } from './labels.js';

/**
 * 结算成因与时限档位的文案（P-02 / H18）。
 *
 * 这两条都是「纯字符串映射」，但它们决定玩家在结算页看到什么：
 * 同一句「败北」有四种成因（被打死 / 认输 / 对手掉线 / 40 轮血量裁定），
 * 说错了玩家会以为自己被规则坑了。故按**视角**逐条钉住。
 */
describe('结算成因行（P-02 / D-238）', () => {
  it('血量归零：按胜负说清是谁的指挥官没了', () => {
    expect(endReasonText('health', false, true)).toBe('对方指挥官生命归零');
    expect(endReasonText('health', false, false)).toBe('你的指挥官生命归零');
  });

  it('即死模式：点明「是在即死模式里掉血死的」', () => {
    expect(endReasonText('sudden-death', false, false)).toContain('即死模式');
    expect(endReasonText('sudden-death', false, true)).toContain('即死模式');
  });

  it('40 轮：说清是按血量裁定，而不是含糊的「超时」', () => {
    expect(endReasonText('turn-limit', false, true)).toContain('血量更高');
    expect(endReasonText('turn-limit', false, false)).toContain('血量更高');
  });

  it('认输 / 对手离开：分清「我投的」和「对面走了」', () => {
    expect(endReasonText('concede', false, false)).toBe('你已认输');
    expect(endReasonText('concede', false, true)).toBe('对手认输');
    expect(endReasonText('opponent-left', false, true)).toContain('对手离开');
    expect(endReasonText('opponent-left', false, false)).toContain('你离开');
  });

  it('判和固定一句，与胜负无关（老口径的 40 轮判和）', () => {
    expect(endReasonText('draw', false, false)).toBe('40 轮未分胜负');
    expect(endReasonText(null, true, false)).toBe('40 轮未分胜负');
  });

  it('未知 / 缺失成因返回 null —— 宁可不显示，也不印 undefined', () => {
    expect(endReasonText(null, false, false)).toBeNull();
    expect(endReasonText('some-future-reason', false, true)).toBeNull();
  });
});

describe('回合时限档位文案（H18）', () => {
  it('四个档位都有修饰语，不是裸数字', () => {
    for (const ms of [30_000, 60_000, 180_000, 999_000]) {
      expect(turnTimeoutLabel(ms)).toMatch(/秒|分钟/);
      expect(turnTimeoutLabel(ms)).not.toBe(`${ms / 1000} 秒`);
    }
  });

  it('默认档标了「默认」，999 标了「基本不限时」', () => {
    expect(turnTimeoutLabel(60_000)).toContain('默认');
    expect(turnTimeoutLabel(999_000)).toContain('不限时');
  });

  it('未知档位回落成「N 秒」而不是崩溃（新增档位忘写文案时仍可用）', () => {
    expect(turnTimeoutLabel(120_000)).toBe('120 秒');
  });
});
