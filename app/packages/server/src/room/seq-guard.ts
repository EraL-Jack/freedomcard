import type { PlayerId } from '@app/shared';

export type GuardVerdict = { ok: true } | { ok: false; reason: 'DUPLICATE' | 'STALE' };

/**
 * `(playerId, seq)` 去重表。
 *
 * 归属：**服务端 Room 会话层**（ADR-0011），不进 `GameState`、不在 `core` 内实现 ——
 * 它不影响任何游戏结果，入 state 会让快照随回合线性膨胀并污染哈希。
 *
 * 语义：seq 必须**严格递增**。等于 `lastSeq` 判重复，小于判乱序（网络重排导致的迟到包）。
 */
export class SeqGuard {
  private readonly last = new Map<PlayerId, number>();

  check(playerId: PlayerId, seq: number): GuardVerdict {
    const last = this.last.get(playerId);
    if (last === undefined) {
      if (seq <= 0) return { ok: false, reason: 'STALE' };
      this.last.set(playerId, seq);
      return { ok: true };
    }
    if (seq === last) return { ok: false, reason: 'DUPLICATE' };
    if (seq < last) return { ok: false, reason: 'STALE' };
    this.last.set(playerId, seq);
    return { ok: true };
  }

  /** 重连时下发给客户端的续发起点依据。 */
  lastSeqOf(playerId: PlayerId): number {
    return this.last.get(playerId) ?? 0;
  }

  /** 席位释放时清空，避免同一 playerId 复用旧游标。 */
  reset(playerId: PlayerId): void {
    this.last.delete(playerId);
  }
}
