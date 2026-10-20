import { describe, expect, it } from 'vitest';

import { createInitialState, stateHash } from '@app/core';

import { ReplayRecorder } from './replay.js';
import { seedGameState, seedSetup } from './session.js';

/**
 * 回放的可重建性（D-159）。
 *
 * 要钉住的是一件事：`replay.json` 里的 `setup` 必须足以**从零重建开局状态**，
 * 且重建出来的哈希与 `initialHash` 一致。不然后人拿到的只是一串无法复现的 Intent。
 */
describe('回放装配参数（D-159）', () => {
  const seats = ['p1', 'p2'];

  it('seedSetup 能重建出与 seedGameState 完全一致的开局状态', () => {
    const opts = { seats, seed: 20261013 };
    const setup = seedSetup(opts);
    const built = seedGameState(opts);
    const rebuilt = createInitialState(setup);

    expect(rebuilt).toEqual(built);
    expect(stateHash(rebuilt)).toBe(stateHash(built));
    expect(setup.seats).toEqual([...seats]);
    expect(Object.keys(setup.decks).sort()).toEqual(['p1', 'p2']);
    expect(Object.keys(setup.commanders).sort()).toEqual(['p1', 'p2']);
  });

  it('自建卡组会覆盖 setup.decks，指挥官单独记录（D-184）', () => {
    const custom = Array.from({ length: 30 }, () => 'frostRecruit');
    const base = seedSetup({ seats, seed: 7 });
    const setup = seedSetup({ seats, seed: 7, decks: { p1: custom } });

    expect(setup.decks['p1']).toEqual(custom);
    expect(setup.decks['p2']).toEqual(base.decks['p2']);
    // 指挥官由 commanders 独立决定，卡组不参与（开局才入区，此刻只存在 setup 里）
    expect(setup.commanders).toEqual(base.commanders);
    for (const id of seats) expect(setup.commanders[id]).toBeTruthy();
  });

  it('markStart 写入 setup 与 initialHash，随记录一起产出', () => {
    const opts = { seats, seed: 42 };
    const setup = seedSetup(opts);
    const initial = seedGameState(opts);

    const rec = new ReplayRecorder(0);
    expect(rec.current().setup).toBeNull(); // 开局前是空的
    rec.markStart(setup, stateHash(initial));

    const out = rec.finish(null, 1);
    expect(out.setup).toEqual(setup);
    expect(out.initialHash).toBe(stateHash(initial));

    // 用记录里的 setup 重建，哈希必须对得上 —— 这就是「可复现」的定义
    expect(stateHash(createInitialState(out.setup!))).toBe(out.initialHash);
  });
});

/**
 * BO3 多局归档（D-175）。
 *
 * 要钉住的是：`markStart` 每局都会调一次，若 `intents` 继续往同一个数组里 push，
 * 记录里会出现**两个 `game:start`** —— 重放到第二个必然被拒（「对局已开始」），
 * 整份文件就不可重放了。实测在 4 份历史文件上复现过。
 */
describe('BO3 多局归档（D-175）', () => {
  const mkSetup = (seed: number) => ({
    seed,
    seats: ['a', 'b'],
    decks: { a: [] as string[], b: [] as string[] },
    commanders: { a: 'bladeLord', b: 'frostAdjudicator' },
  });
  const mkIntent = (seq: number) => ({
    type: 'game:start',
    actor: 'system' as const,
    playerId: 'a',
    seq,
  });

  it('第二局开始时把上一局推进 rounds，并从空序列重新开始', () => {
    const rec = new ReplayRecorder(0);

    rec.markStart(mkSetup(1), 'hashA');
    rec.recordStep(mkIntent(1), [], 'h1');
    expect(rec.current().rounds).toHaveLength(0);

    // 第 2 局开局
    rec.markStart(mkSetup(2), 'hashB');
    const mid = rec.current();
    expect(mid.rounds).toHaveLength(1);
    expect(mid.rounds[0]!.setup.seed).toBe(1);
    expect(mid.rounds[0]!.initialHash).toBe('hashA');
    expect(mid.rounds[0]!.intents).toHaveLength(1);
    // 新局从空开始 —— 这条是关键：不然就会有两个 game:start 挤在同一段
    expect(mid.intents).toHaveLength(0);
    expect(mid.hashChain).toHaveLength(0);
    expect(mid.setup?.seed).toBe(2);
  });

  it('三局时 rounds 有两项，顶层是最后一局', () => {
    const rec = new ReplayRecorder(0);
    for (const seed of [1, 2, 3]) {
      rec.markStart(mkSetup(seed), `hash${seed}`);
      rec.recordStep(mkIntent(1), [], `h${seed}`);
    }
    const out = rec.finish();

    expect(out.rounds.map((r) => r.setup.seed)).toEqual([1, 2]);
    expect(out.setup?.seed).toBe(3);
    expect(out.intents).toHaveLength(1);
    // 每局各自的 intent 数都是 1 —— 没有被前面的局污染
    expect(out.rounds.every((r) => r.intents.length === 1)).toBe(true);
  });

  it('单局记录不产生 rounds（保持旧格式形状）', () => {
    const rec = new ReplayRecorder(0);
    rec.markStart(mkSetup(1), 'hashA');
    rec.recordStep(mkIntent(1), [], 'h1');
    const out = rec.finish();
    expect(out.rounds).toEqual([]);
    expect(out.setup?.seed).toBe(1);
  });
});

/** 空房间不落盘（D-177）—— 没开过局的房间不该产生回放文件。 */
describe('hasContent（D-177）', () => {
  it('从未开局、也没有任何 Intent → false', () => {
    const rec = new ReplayRecorder(0);
    expect(rec.hasContent()).toBe(false);
  });

  it('调用过 markStart → true（哪怕还没有任何 Intent）', () => {
    const rec = new ReplayRecorder(0);
    rec.markStart(
      { seed: 1, seats: ['a', 'b'], decks: { a: [], b: [] }, commanders: { a: 'x', b: 'y' } },
      'h',
    );
    expect(rec.hasContent()).toBe(true);
  });

  it('有 Intent 也算内容（setup 缺失时也要保住记录）', () => {
    const rec = new ReplayRecorder(0);
    rec.recordStep({ type: 'game:start', actor: 'system', playerId: 'a', seq: 1 }, [], 'h');
    expect(rec.hasContent()).toBe(true);
  });
});
