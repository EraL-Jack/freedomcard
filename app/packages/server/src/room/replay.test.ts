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

  it('自建卡组会覆盖 setup.decks（只换主卡组，指挥官仍由阵营决定）', () => {
    const custom = Array.from({ length: 30 }, () => 'frostRecruit');
    const base = seedSetup({ seats, seed: 7 });
    const setup = seedSetup({ seats, seed: 7, decks: { p1: custom } });

    expect(setup.decks['p1']).toEqual(custom);
    expect(setup.decks['p2']).toEqual(base.decks['p2']);
    // 指挥官不受自建卡组影响：仍是该阵营那一张（开局才入区，此刻只存在 setup 里）
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
