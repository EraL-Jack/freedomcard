import { INTENTS, activePlayer } from '@app/core';
import type { GameState, Intent } from '@app/shared/types';

/**
 * 回合超时兜底 Intent 的构造（T-05 / ADR-0017）。
 *
 * ## 为什么单独成文件
 *
 * 这段逻辑原来内联在 `server/src/index.ts` 的 `handleTurnTimeout` 里 ——
 * 那个函数要读 socket.io 实例与模块级房间表，**任何单测都进不去**，
 * 于是「超时真的会结束回合」这条长期零覆盖（docs/21 T-05）。
 *
 * 把「构造 Intent」抽出来（纯函数、零依赖）之后，测试能一路跑到
 * `core.applyIntent` → `reduce`，验证回合确实推进了；剩下的只有 socket 广播这一层，
 * 而它由 E2E 覆盖。
 *
 * ## 为什么超时不直接改状态
 *
 * ADR-0011：超时以**系统 Intent**入事件流，与玩家操作走完全相同的处理链
 * （去重 → 引擎校验 → 产出事件 → reduce → 哈希 → 回放 → 广播）。
 * 直接改 `GameState` 会让服务端与客户端 reduce 出不同结果，`stateHash` 必然对不上。
 *
 * @param serverSeq 当前房间的广播序号 —— 新 Intent 取 `+1`（与玩家 Intent 同一序列空间）
 * @returns 未开局 / 已分胜负 / 无行动方时返回 `null`（此时没有「该超时的人」）
 */
export function buildTimeoutIntent(state: GameState, serverSeq: number): Intent | null {
  // 已结束的对局不该再推进回合：调用方虽然也判了 gameOver，但那是会话层的时序，
  // 定时器回调可能比它晚一拍（例如结算事件正在播放）。这里自守一层，
  // 免得超时把一局已经结束的对局推到下一回合，日志里凭空多出一条 turn:changed。
  if (state.winner !== null || state.draw) return null;
  const active = activePlayer(state);
  if (!active) return null;
  return {
    type: INTENTS.turnEnd,
    // `system` 让引擎跳过「回合归属」「待定选择」等玩家守卫（ADR-0011）
    actor: 'system',
    playerId: active,
    seq: serverSeq + 1,
    reason: 'timeout',
  };
}
