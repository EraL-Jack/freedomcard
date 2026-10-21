import { describe, expect, it } from 'vitest';

import { ackTimeoutText, endReasonText, linkBannerText, turnTimeoutLabel } from './labels.js';

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

/**
 * 断线横幅（D-255）。
 *
 * 起因是 Era 报「点击人机对战没反应」：socket 断开时 `emit` 静默排队，
 * 按钮点下去没有任何反馈。横幅是玩家唯一能看到的解释，所以三种连接态都要钉住 ——
 * 尤其 `online` 必须**返回 null**，否则正常对局里会常挂一条误导性的警告。
 */
describe('断线横幅文案（D-255）', () => {
  it('连接正常时不挂横幅', () => {
    expect(linkBannerText('online')).toBeNull();
  });

  it('正在连接与已断开要分开说', () => {
    expect(linkBannerText('connecting')).toContain('正在连接');
    expect(linkBannerText('offline')).toContain('断开');
  });

  it('两种异常态都要说明「操作暂停」或「连上后可继续」，不能只报状态', () => {
    expect(linkBannerText('connecting')).toContain('继续操作');
    expect(linkBannerText('offline')).toContain('暂停');
  });
});

/**
 * ack 超时提示（D-256）。
 *
 * 这条文案是「点了没反应」的最后一道网：8 秒没回应时，玩家必须知道
 * 「可以重试」和「一直不好就刷新」这两件具体的事，而不是盯着一个转圈的按钮。
 */
describe('建/加房等不到回应的提示（D-256）', () => {
  it('说清等了几秒', () => {
    expect(ackTimeoutText(8)).toContain('8 秒');
  });

  it('给两条可执行的出路：重试、刷新', () => {
    const t = ackTimeoutText(8);
    expect(t).toContain('重试');
    expect(t).toContain('刷新');
  });

  it('不出现 undefined / 空串（拼接秒数时最容易漏）', () => {
    const t = ackTimeoutText(8);
    expect(t).not.toContain('undefined');
    expect(t.length).toBeGreaterThan(10);
  });
});
