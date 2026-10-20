/**
 * 按 key 的固定窗口限流（ADR-0039）。
 *
 * 为什么是**固定窗口**而不是滑动窗口：这里要挡的是「脚本级」洪泛 ——
 * 真人建房一次要几十秒，脚本是每秒数千次，两者差三个数量级，窗口精度差几秒毫无意义。
 * 固定窗口只存 `{ start, count }`，内存是滑动窗口的 1/N，且没有「数组无限增长」的隐患。
 *
 * 为什么**按连接**而不是按 IP：`docs/20` §8.2 记录过一条部署事实 ——
 * 走 frpc TCP 隧道时，所有公网客户端在服务端眼里都是 `127.0.0.1`（L4 转发，没有 XFF）。
 * 按 IP 限流会把所有朋友算成同一个人，一个人手快、其他人一起被限。
 */
export interface WindowRateLimitOptions {
  /** 每个窗口允许的次数。 */
  limit: number;
  /** 窗口长度（毫秒）。 */
  windowMs: number;
  /** 注入时钟，便于测试。 */
  now: () => number;
}

export type RateLimitResult = { ok: true } | { ok: false; retryAfterMs: number };

interface Bucket {
  /** 本窗口的起点。 */
  start: number;
  count: number;
}

export class WindowRateLimit {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: WindowRateLimitOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.now = options.now;
  }

  /**
   * 尝试占用一次配额。
   *
   * 被拒时返回 `retryAfterMs` —— 调用方据此给出「请等 N 秒」这类人话，
   * 而不是只回一个错误码。
   */
  take(key: string): RateLimitResult {
    const now = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.start >= this.windowMs) {
      this.buckets.set(key, { start: now, count: 1 });
      return { ok: true };
    }
    if (bucket.count >= this.limit) {
      return { ok: false, retryAfterMs: Math.max(1, this.windowMs - (now - bucket.start)) };
    }
    bucket.count += 1;
    return { ok: true };
  }

  /**
   * 忘掉某个 key。**连接断开时必须调用**，否则这张表会随连接数单调增长 ——
   * 那就成了「限流本身变成内存泄漏」。
   */
  forget(key: string): void {
    this.buckets.delete(key);
  }

  /** 当前被跟踪的 key 数（诊断用）。 */
  get size(): number {
    return this.buckets.size;
  }
}
