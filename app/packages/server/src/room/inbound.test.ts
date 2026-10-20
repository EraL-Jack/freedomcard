/**
 * 入站 Intent 归一（D-239 / T-09）—— 安全边界，必须被测试钉住。
 *
 * 这条逻辑很不起眼，但它守着两件事：客户端不能冒充系统 Intent 绕过回合限制；
 * 也不能伪造 `reason` 把认输记成「对手掉线」。
 */

import { describe, expect, it } from 'vitest';

import type { Intent } from '@app/shared';

import { normalizePlayerIntent } from './inbound.js';

const raw = (extra: Partial<Intent>): Intent => ({
  type: 'card:play',
  actor: 'player',
  playerId: 'p1',
  seq: 3,
  payload: { uid: 'p1#h1' },
  ...extra,
});

describe('normalizePlayerIntent', () => {
  it('客户端自称 system → 一律改回 player（否则 baseGuard 的回合检查整条跳过）', () => {
    const out = normalizePlayerIntent(raw({ actor: 'system' }));
    expect(out.actor).toBe('player');
  });

  it('伪造 reason（如 opponent-left）→ 清空（结算成因才可信）', () => {
    const out = normalizePlayerIntent(raw({ type: 'game:concede', reason: 'opponent-left' }));
    expect(out.reason).toBeUndefined();
  });

  it('业务字段原样保留（type / playerId / seq / payload）', () => {
    const out = normalizePlayerIntent(raw({}));
    expect(out.type).toBe('card:play');
    expect(out.playerId).toBe('p1');
    expect(out.seq).toBe(3);
    expect(out.payload).toEqual({ uid: 'p1#h1' });
  });

  it('不修改入参（纯函数）', () => {
    const input = raw({ actor: 'system', reason: 'timeout' });
    normalizePlayerIntent(input);
    expect(input.actor).toBe('system');
  });
});
