/**
 * 指挥官力量值成长 —— `docs/06` X-7（Era 2026-10-13）。
 *
 * Era 原话：**「是初始0然后每个充能阶段成长，第一回合就会变到1」**。
 *
 * 解读（ADR-0016 §1）：`powerCurve` 是**档位序列**，不是「回合号 → 力量值」的映射表。
 * 初始取第 0 档；此后每经过一次**己方**充能阶段推进一档。故 `[0,1,3,5]` 的实际结果为：
 *
 * | 时点 | 档位 | 力量值 |
 * | --- | --- | --- |
 * | 开局（揭示指挥官时） | 0 | 0 |
 * | 第 1 回合充能阶段后 | 1 | 1 |
 * | 第 2 回合充能阶段后 | 2 | 3 |
 * | 第 3 回合充能阶段后 | 3 | 5 |
 * | 第 4 回合及以后 | 3（封顶） | 5 |
 *
 * 若按「回合号查表」，开局时 `turn === 1` 就会直接取 1，与 Era 说的「初始 0」矛盾 ——
 * 这也是必须按档位推进而非按回合换算的原因。
 *
 * ⚠️ **推进点有两个，缺一不可**（ADR-0016 §3）：
 *  - `start.ts`：开局后正处第一回合的充能阶段，此时是「已经在该阶段」而没有「进入」动作；
 *  - `phase.ts`：`advanceOnce` 进入 `charge` 阶段时（上一回合结束 → 下一回合）。
 *
 * 只接一处，先攻方（或后攻方）的指挥官会永远停在初始档。
 *
 * ⚠️ 本文件是**阶段的自动效果**，不是 Intent 处理器，故**不进** `rules/index.ts` 注册表。
 */

import {
  type GameEvent,
  type GameState,
  type PlayerId,
  type RuleContext,
} from '@app/shared';

import { defOf, ev, powerCurveOf } from '../ops.js';

/**
 * 让指定玩家的指挥官力量值推进一档，返回产生的事件。
 *
 * 返回空数组的三种情形（都是**静默跳过**，不报错）：
 *  1. 玩家不在座；
 *  2. 指挥官未定义曲线 —— 按定长 `power` 处理，本来就不成长；
 *  3. 档位已到曲线末尾 —— 封顶，不再产出重复事件（ADR-0016 §5）。
 */
export function growCommander(
  state: GameState,
  playerId: PlayerId,
  ctx: RuleContext,
): GameEvent[] {
  const p = state.players[playerId];
  if (!p) return [];

  const def = defOf(ctx.cards, p.commanderDefId);
  const curve = powerCurveOf(def);
  if (!def || !curve) return [];

  const index = Math.min(p.commanderPowerIndex + 1, curve.length - 1);
  if (index === p.commanderPowerIndex) return [];

  return [ev(ctx.now, 'commander:grown', { playerId, index, power: curve[index] ?? def.power })];
}
