/**
 * 星轨观测者（starWatcher）—— docs/17 §3（D-230）。
 *
 * ```
 * 指挥官
 * Ⅰ 攻击时【1】：按星轨层数从卡组顶展示，触发其中所有「展示时」效果，
 *    然后将这些卡按原顺序置入牌库底：
 *      0–2 层：2 张
 *      3–5 层：3 张
 *      6 层及以上：4 张
 * Ⅱ 每当你展示 1 张卡时：获得 1 层星轨（永久累积，不清零）。
 * ```
 *
 * Ⅰ 挂在**指挥官攻击**上（每回合最多一次），不是随从攻击 ——
 * 所以不受前排与冻结影响，这是星轨「引擎不会被场面打断」的立足点。
 * 本次攻击是否选择付费，由 `commander:attack` 的 `payload.reveal` 表达
 * （不发动 = 不付费，卡面不写「可以」，见 docs/18 §4.0）。
 */

import { RULE_ERRORS, STAR_TRACK_BASE_REVEAL, STAR_TRACK_TIERS } from '@app/shared/constants';
import type { GameEvent, Result, Rejection } from '@app/shared/types';

import { playerOf, reject } from '../ops.js';

import { payCostCards, starRevealEvents, type EffectModule } from './index.js';

/** 这次展示几张（docs/17 §2.2 档位表）。 */
export function revealCountFor(starTrack: number): number {
  const [tier3, tier6] = STAR_TRACK_TIERS;
  if (starTrack >= tier6) return STAR_TRACK_BASE_REVEAL + 2;
  if (starTrack >= tier3) return STAR_TRACK_BASE_REVEAL + 1;
  return STAR_TRACK_BASE_REVEAL;
}

export const starWatcherEffect: EffectModule = {
  onCommanderAttack(state, intent, ctx): Result<GameEvent[], Rejection> {
    const me = intent.playerId;
    const p = playerOf(state, me);
    if (!p) return reject(RULE_ERRORS.NOT_STARTED, '玩家不在本局');

    // 【1】：与出牌共用 maxCost 记帐（docs/16 §3.3）。
    const pay = payCostCards(ctx.now, me, p, 1);
    if (!Array.isArray(pay)) return { ok: false, error: pay };

    const count = revealCountFor(p.starTrack);
    const r = starRevealEvents(ctx.now, state, me, count, ctx);
    return { ok: true, value: [...pay, ...r.events] };
  },
};
