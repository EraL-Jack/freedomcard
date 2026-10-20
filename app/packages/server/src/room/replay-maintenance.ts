/**
 * 回放文件保留策略（X-20 / ADR-0040）。
 *
 * 每个房间销毁时落一份 JSON 到 `app/replays/`，此前**没有任何删除逻辑**。
 * 实测（2026-10-20）8 天累积 903 份 / 12.7 MB，约 113 份/天 —— 一年约 4.1 万份 / 590 MB。
 * 磁盘不会被一年写满，但文件数没有上限会拖慢备份与全盘扫描，且尖峰（被刷出十万间房）
 * 无法回收。
 *
 * 本模块只负责**算与删**，不含定时器：什么时候跑由调用方（`index.ts`）决定，
 * 这样 `planReplaySweep` 可以是纯函数，边界条件全都能用单测钉住。
 */
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** 一份回放文件的元信息（不读内容 —— 清理只看大小与时间）。 */
export interface ReplayFile {
  path: string;
  bytes: number;
  mtimeMs: number;
}

export interface ReplaySweepPlan {
  /** 扫到的文件总数。 */
  scanned: number;
  totalBytes: number;
  /** 待删除的文件，**按 mtime 从旧到新**（删的顺序要可解释）。 */
  remove: ReplayFile[];
  removeBytes: number;
  /** 保留的文件数与体积。 */
  kept: number;
  keptBytes: number;
}

export interface PlanInput {
  files: readonly ReplayFile[];
  /** 保留天数 —— 早于 `now - keepDays` 的才可能被删。 */
  keepDays: number;
  /** 目录总量上限（字节），超出后继续从最旧的删。 */
  maxBytes: number;
  now: number;
  /**
   * 保护窗口：最近这段时间内写过的文件**绝不删**。默认 1 小时。
   *
   * 存在的理由很具体：清理与落盘都是异步的，删文件的那一刻可能正好有一份刚写完，
   * 甚至正在写。时间戳看起来旧、内容还没写完的文件删掉就是静默丢数据。
   */
  protectMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PROTECT_MS = 60 * 60 * 1000;

/**
 * 纯函数：给定文件清单与策略，算出「删哪些」。
 *
 * 两条规则依次生效：
 * 1. **保留期**：早于 `now - keepDays` 的删；
 * 2. **总量上限**：第 1 步之后若仍超 `maxBytes`，继续从最旧的删，直到不超。
 *
 * 两条都受保护窗口约束 —— 最近写过的一律不动。
 */
export function planReplaySweep(input: PlanInput): ReplaySweepPlan {
  const protectMs = input.protectMs ?? DEFAULT_PROTECT_MS;
  const expireBefore = input.now - input.keepDays * DAY_MS;
  const protectAfter = input.now - protectMs;

  const totalBytes = input.files.reduce((sum, f) => sum + f.bytes, 0);
  // 最旧优先；同一毫秒时按路径定序，保证输出稳定（否则单测会飘）。
  const ordered = [...input.files].sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));

  const remove: ReplayFile[] = [];
  const survivors: ReplayFile[] = [];
  for (const file of ordered) {
    const expired = file.mtimeMs < expireBefore;
    const tooFresh = file.mtimeMs >= protectAfter;
    if (expired && !tooFresh) {
      remove.push(file);
      continue;
    }
    survivors.push(file);
  }

  let keptBytes = survivors.reduce((sum, f) => sum + f.bytes, 0);
  for (const file of survivors) {
    if (keptBytes <= input.maxBytes) break;
    // survivors 已按 mtime 升序：一旦撞到保护窗口，后面的只会更新，全部不能删。
    if (file.mtimeMs >= protectAfter) break;
    remove.push(file);
    keptBytes -= file.bytes;
  }

  remove.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  return {
    scanned: input.files.length,
    totalBytes,
    remove,
    removeBytes: remove.reduce((sum, f) => sum + f.bytes, 0),
    kept: input.files.length - remove.length,
    keptBytes,
  };
}

/** 列出目录下的回放文件（只认 `.json`；目录不存在时返回空表）。 */
export async function listReplayFiles(dir: string): Promise<ReplayFile[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files: ReplayFile[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      files.push({ path, bytes: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // 读不到就跳过 —— 可能刚被别的实例删掉。
    }
  }
  return files;
}

export interface SweepOptions extends Omit<PlanInput, 'files' | 'now'> {
  dir: string;
  now?: number;
  /** 只算不删（首次上线先看报告用）。 */
  dryRun?: boolean;
}

/**
 * 扫描 + 计划 + （可选）执行。
 *
 * 单个文件删除失败不中断整体 —— 记进 `failed` 由调用方打日志。
 * 这与回放落盘同一个取舍（D-176）：清理是后台维护，不能因为它挂掉服务。
 */
export async function sweepReplayDir(options: SweepOptions): Promise<ReplaySweepPlan & { failed: number }> {
  const files = await listReplayFiles(options.dir);
  const plan = planReplaySweep({
    files,
    keepDays: options.keepDays,
    maxBytes: options.maxBytes,
    now: options.now ?? Date.now(),
    ...(options.protectMs === undefined ? {} : { protectMs: options.protectMs }),
  });

  if (options.dryRun) return { ...plan, failed: 0 };

  let failed = 0;
  for (const file of plan.remove) {
    try {
      await unlink(file.path);
    } catch {
      failed += 1;
    }
  }
  return { ...plan, failed };
}
