/**
 * 攻击 —— **占位，不实现**。
 *
 * 为什么留空而不写一个「合理」的版本：结算所必需的字段 Era 还没给，
 * 自己补一个数值就等于替 Era 发明玩法，与本项目的铁律冲突。
 *
 * 缺什么：
 *  1. **随从没有生命值字段。** A6 字段表只给了 `cost` / `power` / `damage`，
 *     三者都不是「生命」。没有生命就无法回答「随从挨了多少点会死」。
 *  2. **`damage` 的取值范围与含义未给。** A6 字段表里这一行是空的；
 *     它与 `power` 是同一个东西的两个名字，还是两回事，不清楚。
 *     因此「一次攻击造成多少伤害」没有依据 —— 本文件不挑一个默认值。
 *  3. **互伤规则未给。** 攻击方打随从时，防守方是否反击，A9 没有说。
 *  4. **嘲讽的裁决范围未给。** A7 只定义了「对手随从攻击时必须优先选择此目标」，
 *     没说多个嘲讽时怎么选、以及没有随从时能否直接打指挥官。
 *
 * 已确定的部分（不阻塞）：A9-2 每个单位每回合攻击 1 次，攻击后进入休眠态，
 * 重置阶段清除。这部分的数据结构（`CardInstance.sleeping`）与事件
 * （`unit:asleep` / `units:reset`）已经就位，接上即可用。
 *
 * 接入方式：Era 给出上述输入后，在本文件实现并注册 `attack:declare`，
 * **不需要改动任何既有规则文件**（`ops.ts` 的原语已够用）。
 */

import type { GameState, Intent, Result, Rejection, RuleContext } from '@app/shared';
import type { GameEvent } from '@app/shared';

export const attackRule = (
  _state: GameState,
  _intent: Intent,
  _ctx: RuleContext,
): Result<GameEvent[], Rejection> => ({
  ok: false,
  error: {
    code: 'NOT_IMPLEMENTED',
    message: '攻击结算待 Era 补充：随从生命值字段、damage 含义、互伤规则、嘲讽裁决',
  },
});
