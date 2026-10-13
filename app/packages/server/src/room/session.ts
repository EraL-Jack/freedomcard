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

/**
 * 本局随机种子 —— ADR-0021。
 *
 * 默认取系统时间；设了 `GAME_SEED` 环境变量则恒取该值。
 *
 * ⚠️ **`GAME_SEED` 仅供端到端测试使用，生产不得设置** —— 否则每局牌序相同。
 *
 * ## 为什么是「固定种子」而不是「不洗牌」
 *
 * 引擎 RNG 是种子化纯函数（ADR-0010），`seed + Intent 序列` 唯一决定结果，
 * 所以固定 seed 已能确定牌序与先后手。**洗牌照跑，只是结果确定** ——
 * 若改成「测试时不洗牌」，洗牌分支就永远不在自动化测试覆盖范围内了。
 */
export function nextSeed(): number {
  const raw = process.env['GAME_SEED'];
  if (raw === undefined || raw === '') return Date.now() >>> 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n >>> 0 : Date.now() >>> 0;
}

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
