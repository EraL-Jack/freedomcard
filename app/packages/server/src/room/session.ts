import * as core from '@app/core';
import type { GameState, PlayerId } from '@app/shared';

import { defaultDeckSetup } from '../deck-pool.js';

/**
 * 会话编排：把**房间层事实**翻译成**引擎状态** —— ADR-0019「开局桥」。
 *
 * 为什么单独成文件：`server/src/index.ts` 是 socket 入口，import 它就会拉起服务，
 * 写在那里的一切都**无法单测**。把「如何建立一局对局」抽成纯函数后，
 * 「默认卡组 + 座位顺序 → 合法 GameState」这条链路才能被测试钉住。
 *
 * ⚠️ 本文件**不碰 socket**，广播与计时仍由 `index.ts` 的会话层负责 ——
 * 传输与编排分离，是让这段逻辑可测的前提。
 */

export interface SeedOptions {
  /** 座位顺序，按座位号升序。先后手由引擎掷骰决定（A2-4），此处只给「谁在座」。 */
  seats: readonly PlayerId[];
  /** 随机种子，由服务端下发。 */
  seed: number;
}

/**
 * 用「房间座位 + 默认卡组」建立一局**尚未开局**的初始状态。
 *
 * 与 `runtimeOf` 里那个空状态的区别**只在于**带上了真实座位与卡组，
 * 因而能通过 `core.checkDeck` —— 这正是此前开不了局的根因。
 *
 * 调用方拿到返回值后，应构造 `actor: 'system'` 的 `game:start` Intent
 * 交给 `submitSystemIntent`，由引擎完成洗牌 / 掷骰 / 发牌。
 */
export function seedGameState(opts: SeedOptions): GameState {
  const { decks, commanders } = defaultDeckSetup(opts.seats);
  return core.createInitialState({
    seed: opts.seed,
    seats: [...opts.seats],
    decks,
    commanders,
  });
}
