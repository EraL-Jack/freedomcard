/**
 * 入站 Intent 归一（T-09 / D-239）。
 *
 * ## 为什么必须有这一层
 *
 * `actor` 是**客户端自己填的字段**，而它决定了两处安全判定：
 *
 * 1. `baseGuard`（`core/src/ops.ts`）的回合检查写成
 *    `if (intent.actor === 'player' && activePlayer(state) !== intent.playerId)` ——
 *    客户端只要填 `actor: 'system'`，这条守卫就整条跳过，可以在对手回合随便出牌。
 * 2. `applyIntent`（`core/src/engine.ts`）的 `pendingChoice` 全局守卫同样以
 *    `intent.actor === 'player'` 为前提 —— 伪造 `system` 还能绕过「请先完成当前选择」。
 *
 * 「系统 Intent」是**服务端会话层**的特权（超时兜底、掉线判负），它走的是
 * `submitSystemIntent` 这条内部链路，**从不经过 socket 入站**。所以入站侧的
 * 正确做法不是「校验 actor」，而是**无视客户端填的值，一律归一为 player**。
 *
 * ## 为什么连 `reason` 一起清掉
 *
 * `reason` 只对系统 Intent 有意义（如 `'opponent-left'` 让结算显示「对手离开」）。
 * 若留着客户端填的值，玩家可以把自己的认输记成「对手掉线」，结算成因就不可信了。
 */

import type { Intent } from '@app/shared';

/**
 * 把客户端提交的 Intent 归一成「玩家发起」。
 *
 * 保留 `type` / `playerId` / `seq` / `payload`，只覆盖 `actor` 与 `reason`。
 * 纯函数，便于单测 —— 这段逻辑一旦被删掉或改错，不会让任何一条规则测试变红。
 */
export function normalizePlayerIntent(intent: Intent): Intent {
  return { ...intent, actor: 'player', reason: undefined };
}
