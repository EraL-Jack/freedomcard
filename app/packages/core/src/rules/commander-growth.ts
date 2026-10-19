/**
 * 指挥官力量值成长 —— **按轮次同步**（docs/16 §6.3 / ADR-0024）。
 *
 * 旧口径（ADR-0016）是「各自充能阶段推进一档」，实测先手会先到下一档
 * （先手第 2 回合 3 力、后手还在 1 力），先手胜率升到 91.6%。8 血版改为：
 *
 * ```
 * 轮次 = ceil(全局回合数 / 2)
 * powerIndex = min(轮次, 曲线末档)
 * ```
 *
 * 对 `[0,1,3,5]` 即：第 1 轮 1、第 2 轮 3、第 3 轮起 5，**双方始终同力**。
 * 开局（turn = 1，第 1 轮）即为 1，故 `start.ts` 不再单独「成长一次」，
 * 而是直接走本函数把双方都设为第 1 轮的值。
 *
 * ⚠️ 本文件是**阶段/回合的自动效果**，不是 Intent 处理器，故**不进** `rules/index.ts` 注册表。
 */

import { type GameEvent, type GameState, type RuleContext } from '@app/shared';

import { defOf, ev, powerCurveOf } from '../ops.js';

/** 第 `turn` 个全局回合对应的指挥官力量档位（0 基）。 */
export function commanderPowerIndexForTurn(turn: number, curveLength: number): number {
  if (curveLength <= 0) return 0;
  const round = Math.ceil(Math.max(1, turn) / 2);
  return Math.min(round, curveLength - 1);
}

/**
 * 把**双方**指挥官力量档位同步到当前轮次，返回产生的事件。
 *
 * 只对定义了 `powerCurve` 的指挥官生效（未定义 → 按定长 `power`，本来就不成长）。
 * 档位未变时不产事件（避免回放里堆无意义的 `commander:grown`）。
 */
export function syncCommanderGrowth(
  state: GameState,
  turn: number,
  ctx: RuleContext,
): GameEvent[] {
  const events: GameEvent[] = [];
  for (const id of state.seats) {
    const p = state.players[id];
    if (!p) continue;
    const def = defOf(ctx.cards, p.commanderDefId);
    const curve = powerCurveOf(def);
    if (!def || !curve) continue;
    const index = commanderPowerIndexForTurn(turn, curve.length);
    if (index === p.commanderPowerIndex) continue;
    events.push(
      ev(ctx.now, 'commander:grown', { playerId: id, index, power: curve[index] ?? def.power }),
    );
  }
  return events;
}
