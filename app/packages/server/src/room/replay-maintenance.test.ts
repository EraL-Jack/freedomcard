import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { listReplayFiles, planReplaySweep, sweepReplayDir } from './replay-maintenance.js';
import type { ReplayFile } from './replay-maintenance.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

/** 造一份回放元信息：`ageDays` 天前修改，大小 `kb`。 */
function file(name: string, ageDays: number, kb: number): ReplayFile {
  return { path: name, bytes: kb * 1024, mtimeMs: NOW - ageDays * DAY };
}

describe('planReplaySweep · 保留期', () => {
  it('早于保留期的删，晚于的留', () => {
    const plan = planReplaySweep({
      files: [file('old.json', 10, 10), file('mid.json', 3, 10), file('new.json', 0.1, 10)],
      keepDays: 7,
      maxBytes: 100 * 1024 * 1024,
      now: NOW,
    });
    expect(plan.remove.map((f) => f.path)).toEqual(['old.json']);
    expect(plan.kept).toBe(2);
    expect(plan.scanned).toBe(3);
  });

  it('刚好等于保留期边界：不删（严格小于才删）', () => {
    const plan = planReplaySweep({
      files: [file('edge.json', 7, 1)],
      keepDays: 7,
      // 上限要足够大，否则会被「总量上限」那条规则删掉，测不到保留期边界
      maxBytes: 1_000_000,
      now: NOW,
    });
    expect(plan.remove).toHaveLength(0);
  });

  it('空表 → 全 0，不抛错', () => {
    const plan = planReplaySweep({ files: [], keepDays: 7, maxBytes: 1_000, now: NOW });
    expect(plan).toMatchObject({ scanned: 0, totalBytes: 0, removeBytes: 0, kept: 0, keptBytes: 0 });
  });
});

describe('planReplaySweep · 总量上限', () => {
  it('未超上限时只按保留期删', () => {
    const plan = planReplaySweep({
      files: [file('a.json', 1, 10), file('b.json', 2, 10)],
      keepDays: 7,
      maxBytes: 100 * 1024,
      now: NOW,
    });
    expect(plan.remove).toHaveLength(0);
    expect(plan.keptBytes).toBe(20 * 1024);
  });

  it('超上限时从最旧的开始删，删到不超为止', () => {
    const plan = planReplaySweep({
      files: [file('c.json', 1, 10), file('a.json', 3, 10), file('b.json', 2, 10)],
      keepDays: 7,
      // 上限 25 KB：20+20+10=... 三份各 10 KB，共 30 KB，需删 1 份
      maxBytes: 25 * 1024,
      now: NOW,
    });
    expect(plan.remove.map((f) => f.path)).toEqual(['a.json']);
    expect(plan.keptBytes).toBe(20 * 1024);
    expect(plan.keptBytes).toBeLessThanOrEqual(25 * 1024);
  });

  it('删除顺序按 mtime 从旧到新（可解释）', () => {
    const plan = planReplaySweep({
      files: [file('newest.json', 1, 10), file('oldest.json', 20, 10), file('middle.json', 10, 10)],
      keepDays: 7,
      maxBytes: 1_000_000,
      now: NOW,
    });
    expect(plan.remove.map((f) => f.path)).toEqual(['oldest.json', 'middle.json']);
  });
});

describe('planReplaySweep · 保护窗口', () => {
  it('最近写过的文件即使超期也不删（防删到正在写的）', () => {
    const plan = planReplaySweep({
      files: [file('just-written.json', 30, 10)],
      keepDays: 7,
      maxBytes: 1_000_000,
      now: NOW,
      // 保护窗口放到 60 天：这份 30 天前的文件落在窗口内
      protectMs: 60 * DAY,
    });
    expect(plan.remove).toHaveLength(0);
  });

  it('超上限时也遵守保护窗口：宁可暂超，也不删刚写的', () => {
    const plan = planReplaySweep({
      files: [file('fresh.json', 0.01, 100)],
      keepDays: 7,
      maxBytes: 1024,
      now: NOW,
    });
    expect(plan.remove).toHaveLength(0);
    expect(plan.keptBytes).toBeGreaterThan(1024);
  });
});

describe('sweepReplayDir · 真实目录', () => {
  let dir = '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fc-replay-'));
    await writeFile(join(dir, 'a.json'), '{}', 'utf8');
    await writeFile(join(dir, 'b.txt'), 'x', 'utf8');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('只认 .json', async () => {
    const files = await listReplayFiles(dir);
    expect(files.map((f) => f.path.endsWith('a.json'))).toEqual([true]);
  });

  it('dryRun 不删文件', async () => {
    const plan = await sweepReplayDir({
      dir,
      keepDays: -1, // 负数保留期 → 全部「超期」
      maxBytes: 0,
      now: Date.now() + 10 * DAY,
      dryRun: true,
    });
    expect(plan.remove).toHaveLength(1);
    expect(await listReplayFiles(dir)).toHaveLength(1);
  });

  it('正式执行会真的删掉', async () => {
    const plan = await sweepReplayDir({
      dir,
      keepDays: -1,
      maxBytes: 0,
      now: Date.now() + 10 * DAY,
    });
    expect(plan.failed).toBe(0);
    expect(await listReplayFiles(dir)).toHaveLength(0);
  });

  it('目录不存在时返回空表，不抛错', async () => {
    const files = await listReplayFiles(join(dir, 'not-exist'));
    expect(files).toEqual([]);
  });
});
