/**
 * 读 `replay.json` 重放并逐帧比对哈希链 —— T-0016 §6 的遗留项。
 *
 * 用法：
 *   pnpm --filter @app/server run replay:verify <文件路径> [--events]
 *
 * 判据（三条全过才算「可重放」）：
 *  1. 用记录里的 `setup` 重建开局状态，`stateHash` 必须等于 `initialHash`；
 *  2. 逐条重跑 Intent，第 i 步的哈希必须等于 `hashChain[i]`；
 *  3. 加 `--events` 时，还比对每步产出的**事件序列**（按 JSON 深比较）。
 *
 * 退出码：`0` 完全一致 / `1` 有差异 / `2` 文件不可用（无 setup、解析失败等）。
 *
 * ⚠️ 时间源固定为 `startedAt + step * 1000`，**不读真时钟** —— 否则两次重放就会分叉，
 * 而这正是这套工具要抓的那类缺陷（handler 里偷读时钟 / Math.random）。
 */

import { readFile } from 'node:fs/promises';
import process from 'node:process';

import * as core from '@app/core';
import { CARD_POOL } from '@app/shared/cards';

import type { ReplayRecord } from '../room/replay.js';

/** 事件深比较：`JSON.stringify` 在对象键序稳定时足够用（事件都是引擎产出的普通对象）。 */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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

  let record: ReplayRecord;
  try {
    record = JSON.parse(await readFile(file, 'utf8')) as ReplayRecord;
  } catch (e) {
    fail(`读不了这个文件：${(e as Error).message}`);
  }

  if (!record.setup) {
    fail('这份记录没有 `setup`（D-159 之前的旧格式），无法重建开局 —— 它只能用来对照哈希。');
  }

  const setup = record.setup;
  console.info(`文件      ${file}`);
  console.info(`座位      ${setup.seats.join(' / ')}`);
  console.info(`种子      ${setup.seed}`);
  console.info(`步数      ${record.intents.length}`);

  // ① 重建开局
  const initial = core.createInitialState(setup);
  const rebuiltHash = core.stateHash(initial);
  if (record.initialHash && rebuiltHash !== record.initialHash) {
    console.error(`✖ 开局哈希不一致：记录 ${record.initialHash} / 重建 ${rebuiltHash}`);
    process.exit(1);
  }
  console.info(`开局哈希  ${rebuiltHash.slice(0, 16)}… ✓`);

  // ② 逐条重放
  //
  // ⚠️ `now` 必须取**记录里该步第一个事件的 `at`**，不能用「起点 + 步长」推算：
  // `startRule` 会把 `ctx.now` 写进 `state.startedAt`，而原局的 `ctx.now` 是真实时钟，
  // 与 `startedAt`（Recorder 创建时刻）差几百毫秒。用固定步长重放，第一步哈希就对不上。
  const stepAt = (step: number): number => {
    const first = record.events[step]?.[0] as { at?: unknown } | undefined;
    return typeof first?.at === 'number' ? first.at : (record.startedAt ?? 0);
  };

  const outcome = core.replay(initial, record.intents, {
    applyIntent: core.applyIntent,
    reduce: core.reduce,
    stateHash: core.stateHash,
    now: stepAt,
    cards: CARD_POOL,
  });

  if (outcome.failedAt !== null) {
    const step = outcome.failedAt;
    const intent = record.intents[step];
    console.error(
      `✖ 第 ${step + 1} 步被拒绝：${intent?.type} —— ${outcome.failure?.message ?? '（无原因）'}`,
    );
    process.exit(1);
  }

  // ③ 逐帧比对
  let mismatches = 0;
  for (let i = 0; i < record.hashChain.length; i++) {
    const expected = record.hashChain[i];
    const actual = outcome.hashChain[i];
    if (expected !== actual) {
      mismatches++;
      console.error(
        `✖ 第 ${i + 1} 步哈希不一致（${record.intents[i]?.type}）：` +
          `记录 ${expected?.slice(0, 16)}… / 重放 ${actual?.slice(0, 16)}…`,
      );
      if (mismatches >= 3) {
        console.error('  （只显示前三处）');
        break;
      }
    }
  }

  if (compareEvents) {
    for (let i = 0; i < record.events.length; i++) {
      if (!sameJson(record.events[i], outcome.events[i])) {
        mismatches++;
        console.error(`✖ 第 ${i + 1} 步事件不一致（${record.intents[i]?.type}）`);
        if (mismatches >= 3) break;
      }
    }
  }

  if (mismatches > 0) {
    console.error(`\n结论：**不可重放**，共 ${mismatches} 处差异。`);
    process.exit(1);
  }

  console.info(`重放哈希  ${outcome.hashChain.at(-1)?.slice(0, 16) ?? '—'}… ✓`);
  console.info(`\n结论：**可重放** —— ${record.intents.length} 步逐帧一致${compareEvents ? '（含事件）' : ''}。`);
}

void main();
