/**
 * AI 基线模拟 —— issue #137 验收第 2 条（1200 局 AI 自对弈）。
 *
 * ## 为什么不做成常规单测
 *
 * 单局 AI 对弈要跑几百步、每步 `reduce` 一遍事件流；1200 局是分钟级开销，
 * 放进 `pnpm test` 会让每次提交都慢下来，而它测的东西（胜率 / 技能次数）
 * **不是回归线，是调参基线** —— 数值一变就要重跑，结论也不会「红/绿」。
 *
 * 所以默认 `skip`，需要时显式打开：
 *
 * ```bash
 * AI_BASELINE=1 pnpm --filter @app/core test --run src/ai-baseline.test.ts
 * # 想改局数：AI_BASELINE_GAMES=50
 * ```
 *
 * ## 量的是什么
 *
 * | 指标 | 口径 |
 * | --- | --- |
 * | 技能发动 | **被接受的** `effect:activate`（统领/裁决官）+ 带 `reveal` 的 `commander:attack`（观测者） |
 * | 手牌充能 | 被接受的 `charge:put` 里提交的随从张数 |
 * | 先手胜率 | `start` 之后 `seats[0]` 的胜场占比（座位由掷骰重排，不能按入参猜） |
 * | 平均轮数 | `state.turn` ÷ 2 —— `turn` 是**玩家回合**计数，一轮 = 双方各一个回合 |
 * | 顶档可达率 | 该体系的对局里，「除外区炎刃数」曾达到 `BLADE_EXILE_TIERS` 顶档 / 「霜痕」曾达到 `FROST_MARK_TIERS` 顶档的占比。看**峰值**，不看结算余量 |
 * | 体系胜率 | 按指挥官反查体系后汇总（`FACTION_BY_COMMANDER`）；镜像局两边各记一场 |
 * | 空过率 | 玩家回合里没有被接受的 出牌 / 技能 / 攻击 的占比。**充能不算动作** —— 它是强制的，拿来充数会让空过率恒为 0。换牌阶段不计回合 |
 *
 * 前三条按「**意图被接受**」计数，不看事件流里的 `effect:used` ——
 * 后者的键同时被被动触发器（执法者加霜痕、军旗抽牌）使用，按它统计会把被动算成主动。
 *
 * 后三条是 **issue #138 的验收线**（`docs/16 §15.4`），原来的骨架只统计前三条，
 * 导致 §15.4.1 只能写「未测」。这里补齐 —— 指标定义写死在本文件，别在报告里另起口径。
 */

import { describe, expect, it } from 'vitest';

import { CARD_POOL } from '@app/shared/cards';
import {
  DEFAULT_COMMANDER_ID,
  DEFAULT_MAIN_DECK,
  FROST_COMMANDER_ID,
  FROST_MAIN_DECK,
  STAR_COMMANDER_ID,
  STAR_MAIN_DECK,
} from '@app/shared/default-decks';
import type { GameState } from '@app/shared/types';

import { decideAiMove } from './ai.js';
import { BLADE_EXILE_TIERS, FROST_MARK_TIERS } from '@app/shared/constants';

import { bladeExileCount } from './effects/index.js';
import { applyIntent, reduce, INTENTS } from './index.js';
import { createInitialState } from './state.js';

/**
 * core 的 tsconfig 不带 node / dom 类型（引擎层不许碰 IO），
 * 但这个文件是**测试**，要读环境变量、要往 stdout 打表 —— 就地声明用到的两个成员。
 */
declare const process: {
  env: Record<string, string | undefined>;
  stdout: { write(text: string): void };
};

const BASELINE = process.env['AI_BASELINE'] === '1';
const GAMES_PER_PAIR = Number(process.env['AI_BASELINE_GAMES'] ?? 200);

/** 单局统计。 */
interface GameStat {
  /** 被接受的技能发动次数（双方合计）。 */
  skillUses: number;
  /** 被接受的充能张数（双方合计）。 */
  charges: number;
  winner: string | null;
  /** 胜者座位（0 = `seats[0]`）；平局为 `null`。 */
  winnerSeat: 0 | 1 | null;
  /** 先手方（`start` 之后的 `seats[0]`）。 */
  firstSeat: string;
  turns: number;
  /** 每个座位**曾经达到**的最大除外区炎刃数（炎刃顶档可达率）。 */
  maxBlade: [number, number];
  /** 每个座位**曾经达到**的最大霜痕层数（霜律顶档可达率）。 */
  maxFrost: [number, number];
  /** 玩家回合数（不含换牌阶段）。 */
  playerTurns: number;
  /** 其中「什么也没做」（无出牌 / 技能 / 攻击）的回合数。 */
  idleTurns: number;
  /**
   * 其中**一张牌都没打出**（`play` 为 0）的回合数 —— 与 `docs/13`「空过玩家回合占比」
   * 同口径。留着它当交叉验证：若 `idleTurns` 恒为 0 而这里不为 0，说明计数机制在跑，
   * 只是 AI 确实每回合都有动作（0% 是真的，不是没测）。
   */
  idlePlayTurns: number;
}

/** 指挥官 defId → 体系名 —— 体系胜率 / 顶档可达率按它汇总。 */
const FACTION_BY_COMMANDER: Readonly<Record<string, string>> = {
  [DEFAULT_COMMANDER_ID]: '炎刃',
  [FROST_COMMANDER_ID]: '霜律',
  [STAR_COMMANDER_ID]: '星轨',
};

const CTX = { now: 1000, cards: CARD_POOL };

/** 与服务器同形态的系统 Intent 执行者（拒绝即返回 null）。 */
function fire(
  state: GameState,
  type: string,
  playerId: string,
  payload?: Record<string, unknown>,
): GameState | null {
  const r = applyIntent(
    state,
    { type, actor: 'system', playerId, seq: 1, ...(payload ? { payload } : {}) },
    CTX,
  );
  if (!r.ok) return null;
  return r.value.reduce(reduce, state);
}

/** 打完一局，返回统计。 */
function playOne(seed: number, decks: [string[], string[]], cmds: [string, string]): GameStat {
  const base = createInitialState({
    seed,
    seats: ['a1', 'a2'],
    decks: { a1: decks[0], a2: decks[1] },
    commanders: { a1: cmds[0], a2: cmds[1] },
  });

  const started = fire(base, INTENTS.start, 'a1');
  if (!started) throw new Error('game:start 被拒');
  // 显式标成 `GameState`：闭包里引用 `s` 时 TS 不会因为「后面还会重新赋值」放宽成 `| null`
  let s: GameState = started;
  const firstSeat = s.seats[0] ?? 'a1';

  let skillUses = 0;
  let charges = 0;
  const maxBlade: [number, number] = [0, 0];
  const maxFrost: [number, number] = [0, 0];
  let playerTurns = 0;
  let idleTurns = 0;
  let idlePlayTurns = 0;

  /** 采样「体系资源峰值」—— 顶档可达率看的是**曾经达到过**，不是结算时的余量。 */
  const sample = (st: GameState): void => {
    for (let i = 0; i < 2; i++) {
      const id = st.seats[i];
      const p = id === undefined ? undefined : st.players[id];
      if (!p) continue;
      maxBlade[i] = Math.max(maxBlade[i] ?? 0, bladeExileCount(p, CARD_POOL));
      maxFrost[i] = Math.max(maxFrost[i] ?? 0, p.frostMark);
    }
  };

  /*
   * 回合边界记账（空过率）。一个玩家回合里「什么也没做」= 没有被接受的
   * 出牌 / 技能 / 攻击。充能**不算**动作（强制动作，算进去空过率恒为 0）。
   * 换牌阶段不是回合，整段跳过。
   */
  let turnKey = `${s.turn}:${s.activeSeat}`;
  let turnIsMulligan = s.phase === 'mulligan';
  let turnActed = false;
  let turnPlayed = false;
  const closeTurn = (): void => {
    if (turnIsMulligan) return;
    playerTurns += 1;
    if (!turnActed) idleTurns += 1;
    if (!turnPlayed) idlePlayTurns += 1;
  };
  const syncTurn = (st: GameState): void => {
    const key = `${st.turn}:${st.activeSeat}`;
    if (key === turnKey) return;
    closeTurn();
    turnKey = key;
    turnIsMulligan = st.phase === 'mulligan';
    turnActed = false;
    turnPlayed = false;
  };
  const ACTIONS: ReadonlySet<string> = new Set([
    INTENTS.play,
    INTENTS.attack,
    INTENTS.commanderAttack,
    INTENTS.effectActivate,
  ]);

  sample(s);

  for (let steps = 0; steps < 4000; steps++) {
    if (s.winner !== null || s.draw) break;

    // 待定选择可能挂给非行动方（受伤展示），换牌阶段则按「谁还没确认」挑人。
    const actor =
      s.pendingChoice?.playerId ??
      (s.phase === 'mulligan'
        ? s.seats.find((id) => s.players[id]?.mulliganDone !== true)
        : s.seats[s.activeSeat]);
    if (!actor) break;

    const move = decideAiMove(s, actor, CARD_POOL, CTX.now);
    if (!move) break;

    const next = fire(s, move.type, actor, move.payload);
    if (next) {
      // 只有**被接受**的才算数
      if (move.type === INTENTS.effectActivate) skillUses += 1;
      if (move.type === INTENTS.commanderAttack && move.payload?.['reveal'] === true) skillUses += 1;
      if (move.type === INTENTS.charge) {
        const uids = move.payload?.['uids'];
        charges += Array.isArray(uids) ? uids.length : 0;
      }
      if (ACTIONS.has(move.type)) turnActed = true;
      if (move.type === INTENTS.play) turnPlayed = true;
      s = next;
      sample(s);
      syncTurn(s);
      continue;
    }
    // 与服务器同一条兜底：被拒就推进阶段，绝不原地重试。
    const fallback = fire(s, INTENTS.phaseAdvance, actor);
    if (!fallback) break;
    s = fallback;
    syncTurn(s);
  }
  closeTurn();

  const winnerSeat: 0 | 1 | null =
    s.winner === null ? null : s.seats[0] === s.winner ? 0 : 1;

  return {
    skillUses,
    charges,
    winner: s.winner,
    winnerSeat,
    firstSeat,
    turns: s.turn,
    maxBlade,
    maxFrost,
    playerTurns,
    idleTurns,
    idlePlayTurns,
  };
}

interface PairReport {
  name: string;
  games: number;
  skillPerGame: number;
  chargePerGame: number;
  firstWinRate: number;
  avgTurns: number;
  unfinished: number;
}

const PAIRS: { name: string; decks: [string[], string[]]; cmds: [string, string] }[] = [
  { name: '炎刃 vs 炎刃', decks: [DEFAULT_MAIN_DECK as string[], DEFAULT_MAIN_DECK as string[]], cmds: [DEFAULT_COMMANDER_ID, DEFAULT_COMMANDER_ID] },
  { name: '霜律 vs 霜律', decks: [FROST_MAIN_DECK as string[], FROST_MAIN_DECK as string[]], cmds: [FROST_COMMANDER_ID, FROST_COMMANDER_ID] },
  { name: '星轨 vs 星轨', decks: [STAR_MAIN_DECK as string[], STAR_MAIN_DECK as string[]], cmds: [STAR_COMMANDER_ID, STAR_COMMANDER_ID] },
  { name: '炎刃 vs 霜律', decks: [DEFAULT_MAIN_DECK as string[], FROST_MAIN_DECK as string[]], cmds: [DEFAULT_COMMANDER_ID, FROST_COMMANDER_ID] },
  { name: '霜律 vs 星轨', decks: [FROST_MAIN_DECK as string[], STAR_MAIN_DECK as string[]], cmds: [FROST_COMMANDER_ID, STAR_COMMANDER_ID] },
  { name: '星轨 vs 炎刃', decks: [STAR_MAIN_DECK as string[], DEFAULT_MAIN_DECK as string[]], cmds: [STAR_COMMANDER_ID, DEFAULT_COMMANDER_ID] },
];

describe.skipIf(!BASELINE)('AI 基线（issue #137 / #138 验收）', () => {
  it(
    `${PAIRS.length} 组 × ${GAMES_PER_PAIR} 局：技能用起来了，轮数 / 体系胜率 / 空过率落在 \u00a715.4`,
    () => {
      const reports: PairReport[] = [];
      /** 体系汇总：出场人次 / 胜场 / 顶档达到人次。 */
      const faction = new Map<string, { games: number; wins: number; top: number }>();
      let idleTotal = 0;
      let idlePlayTotal = 0;
      let turnTotal = 0;

      // 顶档门槛只从常量取，不在报告里另写一遍数字
      const BLADE_TOP: number = BLADE_EXILE_TIERS[BLADE_EXILE_TIERS.length - 1] ?? 1;
      const FROST_TOP: number = FROST_MARK_TIERS[FROST_MARK_TIERS.length - 1] ?? 1;

      for (const pair of PAIRS) {
        let skill = 0;
        let charge = 0;
        let firstWins = 0;
        let turns = 0;
        let unfinished = 0;
        let idle = 0;
        let idlePlay = 0;
        let playerTurns = 0;

        for (let i = 0; i < GAMES_PER_PAIR; i++) {
          // 固定种子区间：同一份代码重跑结果完全一致，便于对比前后两版本
          const stat = playOne(20261022 + i, pair.decks, pair.cmds);
          skill += stat.skillUses;
          charge += stat.charges;
          turns += stat.turns;
          idle += stat.idleTurns;
          idlePlay += stat.idlePlayTurns;
          playerTurns += stat.playerTurns;
          if (stat.winner === null) unfinished += 1;
          else if (stat.winner === stat.firstSeat) firstWins += 1;

          for (let seat = 0; seat < 2; seat++) {
            const name = FACTION_BY_COMMANDER[pair.cmds[seat] ?? ''] ?? '未知';
            const agg = faction.get(name) ?? { games: 0, wins: 0, top: 0 };
            agg.games += 1;
            if (stat.winnerSeat === seat) agg.wins += 1;
            // 星轨档位本次不动（C-04），不统计顶档可达率
            if (name === '炎刃' && (stat.maxBlade[seat] ?? 0) >= BLADE_TOP) agg.top += 1;
            if (name === '霜律' && (stat.maxFrost[seat] ?? 0) >= FROST_TOP) agg.top += 1;
            faction.set(name, agg);
          }
        }

        idleTotal += idle;
        idlePlayTotal += idlePlay;
        turnTotal += playerTurns;

        reports.push({
          name: pair.name,
          games: GAMES_PER_PAIR,
          skillPerGame: skill / GAMES_PER_PAIR,
          chargePerGame: charge / GAMES_PER_PAIR,
          firstWinRate: firstWins / GAMES_PER_PAIR,
          avgTurns: turns / GAMES_PER_PAIR,
          unfinished,
        });
      }

      // core 的 tsconfig 没带 dom / node 的 console 定义，直接写 stdout
      const lines: string[] = [];
      lines.push('');
      lines.push('| 对局 | 局数 | 技能/局 | 充能张/局 | 先手胜率 | 平均回合 | 平均轮数 | 未结束 |');
      lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
      for (const r of reports) {
        lines.push(
          `| ${r.name} | ${r.games} | ${r.skillPerGame.toFixed(2)} | ${r.chargePerGame.toFixed(2)} | ` +
            `${(r.firstWinRate * 100).toFixed(1)}% | ${r.avgTurns.toFixed(1)} | ` +
            `${(r.avgTurns / 2).toFixed(2)} | ${r.unfinished} |`,
        );
      }
      lines.push('');
      lines.push('| 体系 | 出场人次 | 胜率 | 顶档可达率 | 目标 |');
      lines.push('| --- | --- | --- | --- | --- |');
      for (const name of ['炎刃', '霜律', '星轨']) {
        const agg = faction.get(name);
        if (!agg) continue;
        const top = name === '星轨' ? '不统计（C-04 档位未动）' : `${((agg.top / agg.games) * 100).toFixed(1)}%`;
        const goal = name === '星轨' ? '—' : agg.top / agg.games >= 0.6 ? '≥60% ✅' : '≥60% ⚠️';
        lines.push(
          `| ${name} | ${agg.games} | ${((agg.wins / agg.games) * 100).toFixed(1)}% | ${top} | ${goal} |`,
        );
      }
      lines.push('');
      const idleRate = turnTotal === 0 ? 0 : idleTotal / turnTotal;
      const idlePlayRate = turnTotal === 0 ? 0 : idlePlayTotal / turnTotal;
      lines.push(
        `空过率（无动作玩家回合）：${(idleRate * 100).toFixed(2)}%（${idleTotal}/${turnTotal}），目标 < 7%`,
      );
      lines.push(
        `  交叉验证 · 未出牌回合：${(idlePlayRate * 100).toFixed(2)}%（${idlePlayTotal}/${turnTotal}），` +
          `口径同 docs/13「一张牌都没出」`,
      );
      lines.push('');
      process.stdout.write(lines.join('\n'));

      const totalGames = reports.reduce((n, r) => n + r.games, 0);
      const totalSkill = reports.reduce((n, r) => n + r.skillPerGame * r.games, 0);
      const totalCharge = reports.reduce((n, r) => n + r.chargePerGame * r.games, 0);
      const totalTurns = reports.reduce((n, r) => n + r.avgTurns * r.games, 0);

      // ① 技能必须是「用起来了」，而不是像修复前那样 0 次
      expect(totalSkill).toBeGreaterThan(0);
      // ② 手牌充能同理
      expect(totalCharge).toBeGreaterThan(0);
      // ③ 每局平均至少发动一次技能（#137 验收第 1 条的人机局口径，这里按 AI 视角取更严的一档）
      expect(totalSkill / totalGames).toBeGreaterThanOrEqual(1);
      // ④-⑥ 是 #138 的验收线（docs/16 §15.4）：轮数只看血量这一个旋钮的结果，
      //     体系胜率与空过率是「AI 能不能把牌打出来」的直接体现。
      const avgRounds = totalTurns / totalGames / 2;
      expect(avgRounds).toBeGreaterThanOrEqual(4.5);
      expect(avgRounds).toBeLessThanOrEqual(5.5);
      expect(idleRate).toBeLessThan(0.07);
      for (const [name, agg] of faction) {
        const rate = agg.wins / agg.games;
        expect(rate, `${name} 胜率 ${(rate * 100).toFixed(1)}%`).toBeGreaterThanOrEqual(0.4);
        expect(rate, `${name} 胜率 ${(rate * 100).toFixed(1)}%`).toBeLessThanOrEqual(0.6);
      }
      /*
       * 顶档可达率**不断言** —— #138 明写「目标 ≥60%，达不到就报实际值」，
       * 且 §15.3 的处置是「该体系档位再降一格」（要 Era 同意，因为 7 是他定的）。
       * 断言会把「需要拍板」伪装成「测试红」。
       */
    },
  );
});
