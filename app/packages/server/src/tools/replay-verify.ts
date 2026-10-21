/**
 * 读 `replay.json` 重放并逐帧比对哈希链 —— T-0016 §6 的遗留项。
 *
 * 用法：
 *   pnpm --filter @app/server run replay:verify <文件路径> [--events]
 *
 * 判据（每局都要过）：
 *  1. 用该局的 `setup` 重建开局状态，`stateHash` 必须等于 `initialHash`；
 *  2. 逐条重跑 Intent，第 i 步哈希必须等于 `hashChain[i]`；
 *  3. 加 `--events` 时，还比对每步产出的**事件序列**（按 JSON 深比较）。
 *
 * 退出码：`0` 完全一致 / `1` 有差异 / `2` 文件不可用（无 setup、解析失败等）。
 *
 * ⚠️ 时间源取**记录里该步第一个事件的 `at`**，不能用「起点 + 步长」推算：
 * `startRule` 会把 `ctx.now` 写进 `state.startedAt`，而原局的 `ctx.now` 是真实时钟，
 * 与 `startedAt`（Recorder 创建时刻）差几百毫秒 —— 用固定步长，第一步哈希就对不上。
 *
 * ⚠️ BO3 记录里有 `rounds`（前几局）+ 顶层（最后一局），必须**逐局**重放：
 * 每局都是自己的 `game:start`，混在一起会在第二个开局处被拒（D-175）。
 */

import { readFile } from 'node:fs/promises';
import process from 'node:process';

import * as core from '@app/core';
import type { GameEvent, Intent } from '@app/shared';
import { CARD_POOL } from '@app/shared/cards';

import type { ReplayRecord, ReplayRound, ReplaySetup } from '../room/replay.js';

/** 待验证的一局 —— 归档局与「最后一局」形状一致。 */
interface RoundLike {
  setup: ReplaySetup;
  initialHash: string | null;
  intents: Intent[];
  events: GameEvent[][];
  hashChain: string[];
}

/** 事件深比较：`JSON.stringify` 在对象键序稳定时足够用（事件都是引擎产出的普通对象）。 */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 把一份记录摊平成「按局排列」的列表。
 *
 * 旧格式（无 `setup`）返回空数组；只有 `setup` 没有 `rounds` 的单局记录返回 1 项。
 */
function collectRounds(record: Partial<ReplayRecord>): RoundLike[] {
  const archived: ReplayRound[] = record.rounds ?? [];
  const rounds: RoundLike[] = archived.map((r) => ({
    setup: r.setup,
    initialHash: r.initialHash ?? null,
    intents: r.intents,
    events: r.events,
    hashChain: r.hashChain,
  }));
  if (record.setup) {
    rounds.push({
      setup: record.setup,
      initialHash: record.initialHash ?? null,
      intents: record.intents ?? [],
      events: record.events ?? [],
      hashChain: record.hashChain ?? [],
    });
  }
  return rounds;
}

/** 校验一局；返回差异条数（0 = 通过）。 */
function verifyRound(round: RoundLike, compareEvents: boolean): number {
  /*
   * 旧文件没有 `rngCursor` 字段 —— D-269 之前 `createInitialState` 把初始游标写死 0
   * （那正是 issue #103「每局固定起手」的根因），所以「当时真实的游标」就是 0。
   *
   * 这是一处**历史兼容**，不是默认行为：新录的文件一律带该字段，
   * 走的是它自己记录的值。补 0 之后老文件仍然可校验，D-269 的修复不会
   * 顺带把它们判成损坏。
   */
  const legacyCursor = (round.setup as { rngCursor?: number }).rngCursor ?? 0;
  const initial = core.createInitialState({ ...round.setup, rngCursor: legacyCursor });
  const rebuiltHash = core.stateHash(initial);
  if (round.initialHash && rebuiltHash !== round.initialHash) {
    console.error(`  ✖ 开局哈希不一致：记录 ${round.initialHash} / 重建 ${rebuiltHash}`);
    return 1;
  }

  const outcome = core.replay(initial, round.intents, {
    applyIntent: core.applyIntent,
    reduce: core.reduce,
    stateHash: core.stateHash,
    // 见文件头：必须取该步事件的真实时间
    now: (step) => {
      const first = round.events[step]?.[0] as { at?: unknown } | undefined;
      return typeof first?.at === 'number' ? first.at : 0;
    },
    cards: CARD_POOL,
  });

  if (outcome.failedAt !== null) {
    const step = outcome.failedAt;
    console.error(
      `  ✖ 第 ${step + 1} 步被拒绝：${round.intents[step]?.type} —— ${outcome.failure?.message ?? '（无原因）'}`,
    );
    return 1;
  }

  let diffs = 0;
  for (let i = 0; i < round.hashChain.length; i++) {
    if (round.hashChain[i] !== outcome.hashChain[i]) {
      diffs++;
      console.error(
        `  ✖ 第 ${i + 1} 步哈希不一致（${round.intents[i]?.type}）：` +
          `记录 ${round.hashChain[i]?.slice(0, 16)}… / 重放 ${outcome.hashChain[i]?.slice(0, 16)}…`,
      );
      if (diffs >= 3) {
        console.error('  （只显示前三处）');
        break;
      }
    }
  }

  if (compareEvents) {
    for (let i = 0; i < round.events.length; i++) {
      if (!sameJson(round.events[i], outcome.events[i])) {
        diffs++;
        console.error(`  ✖ 第 ${i + 1} 步事件不一致（${round.intents[i]?.type}）`);
        if (diffs >= 3) break;
      }
    }
  }

  return diffs;
}

function fail(msg: string): never {
  console.error(`✖ ${msg}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const compareEvents = args.includes('--events');

  if (!file) {
    console.error('用法：replay:verify <replay.json> [--events]');
    process.exit(2);
  }

  let record: Partial<ReplayRecord>;
  try {
    record = JSON.parse(await readFile(file, 'utf8')) as Partial<ReplayRecord>;
  } catch (e) {
    fail(`读不了这个文件：${(e as Error).message}`);
  }

  const rounds = collectRounds(record);
  if (rounds.length === 0) {
    fail('这份记录没有 `setup`（D-159 之前的旧格式），无法重建开局 —— 它只能用来对照哈希。');
  }

  console.info(`文件      ${file}`);
  console.info(`局数      ${rounds.length}`);
  console.info(`座位      ${rounds[0]!.setup.seats.join(' / ')}`);

  let bad = 0;
  let steps = 0;
  rounds.forEach((round, i) => {
    steps += round.intents.length;
    const label = rounds.length > 1 ? `第 ${i + 1} 局` : '单局';
    const diffs = verifyRound(round, compareEvents);
    if (diffs === 0) {
      console.info(`  ${label}    ${round.intents.length} 步  ✓`);
    } else {
      bad++;
    }
  });

  if (bad > 0) {
    console.error(`\n结论：**不可重放** —— ${bad}/${rounds.length} 局有差异。`);
    process.exit(1);
  }

  console.info(
    `\n结论：**可重放** —— ${rounds.length} 局共 ${steps} 步逐帧一致${compareEvents ? '（含事件）' : ''}。`,
  );
}

void main();
