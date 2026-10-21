import { INTENTS } from '@app/core';
import type { GameState, Intent, PlayerId } from '@app/shared/types';

/**
 * 换牌阶段超时兜底 Intent 的构造（D-259 / **D-267**）。
 *
 * ## 为什么单独成文件
 *
 * 与 `timeout-intent.ts` 同一个理由：这段逻辑原来内联在 `server/src/index.ts` 的
 * `handleMulliganTimeout` 里，**任何单测都进不去**。零覆盖的代价在 D-267 追回来了：
 *
 * 构造出来的 Intent **漏了 `payload.returns`**，而 `mulliganRule` 要求它必须是
 * uid 数组 —— 于是 30 秒一到，兜底自己先被规则拒掉，换牌阶段关门失败。
 * 更糟的是 system Intent 没有 socket，`emitGameOut` 走的是**广播**分支，
 * 于是全房玩家都会看到那句内部文案「returns 必须是 uid 数组」。
 * Era 2026-10-21 的 issue #99 截到的就是这个。
 *
 * ## 为什么「跳过」要显式带空数组
 *
 * `mulliganRule` 把 `returns` 的合法性当作**入参契约**（`strListArg` 返回 null 就拒），
 * 不替调用方猜「缺参数 = 不想换」。这条严格本身是对的 —— 让引擎替调用方兜底，
 * 「客户端漏发参数」就永远不会被发现。所以修法是在**调用方**补齐，而不是放宽规则。
 *
 * @param playerId 要替谁跳过（未确认的那一方）
 * @param serverSeq 当前房间的广播序号 —— 新 Intent 取 `+1`（与玩家 Intent 同一序列空间）
 */
export function buildMulliganSkipIntent(playerId: PlayerId, serverSeq: number): Intent {
  return {
    type: INTENTS.mulligan,
    // `system` 让引擎跳过「回合归属」等玩家守卫（ADR-0011）
    actor: 'system',
    playerId,
    seq: serverSeq + 1,
    reason: 'mulligan-timeout',
    /*
     * 空数组 = 「保留整手」。**不能省**：`mulliganRule` 会把它当缺失参数拒掉，
     * 而阶段关不掉就意味着整局永久停在换牌阶段（D-267 的原始故障）。
     */
    payload: { returns: [] },
  };
}

/**
 * 换牌阶段还剩哪些人没确认。
 *
 * 抽成纯函数是为了能直接测「谁该被跳过」：`handleMulliganTimeout` 自己要在
 * 每次提交后重读 `state.phase`（前一个人的跳过可能已经关闭了阶段），
 * 那层时序留在会话层，这里只回答「此刻谁还没确认」。
 */
export function pendingMulliganPlayers(state: GameState): PlayerId[] {
  if (!state.started || state.phase !== 'mulligan') return [];
  if (state.winner !== null || state.draw) return [];
  return state.seats.filter((pid) => state.players[pid]?.mulliganDone !== true);
}

/**
 * 换牌窗口的**兜底换算** —— D-267：窗口跟随该房间的回合时限
 * （Era 2026-10-21 issue #99：「我建议换牌时间也按每回合时间来定，不要固定值」）。
 *
 * ## 为什么不再用 `MULLIGAN_WINDOW_MS` 常数
 *
 * 原来的换牌窗口写死 30 秒，与建房时选的回合档位（30 / 60 / 180 / 999 秒）无关 ——
 * 玩家在建房里选了 180 秒，换牌却只有 30 秒，两个时限互相矛盾。
 *
 * ## 为什么这里只做「缺失时回落」
 *
 * 档位的取值口径（**环境变量 > 房间设置 > 默认值**）只留在会话层一处
 * （`index.ts` 的 `resolveTurnTimeout`）。这里再读一遍 `TURN_TIMEOUT_MS` 就等于抄第二份，
 * 哪天放宽口径改了一处、忘了另一处，换牌与回合的两个时限又会打架 ——
 * 而这类「两处都对、拼起来错」的 bug 正是 D-267 的形态。
 *
 * @param roomTimeoutMs 会话层算好的时限（已含环境变量与房间档位）
 * @param fallback 兜底时长（生产环境走不到，仅防御 0 / NaN）
 */
export function mulliganWindowMs(roomTimeoutMs: number, fallback: number): number {
  return Number.isFinite(roomTimeoutMs) && roomTimeoutMs > 0 ? roomTimeoutMs : fallback;
}
