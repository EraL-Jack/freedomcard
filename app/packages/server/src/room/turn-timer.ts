import { TURN_TIMEOUT_MS } from '@app/shared';

/**
 * 回合超时调度 —— ADR-0017。
 *
 * 依据 ADR-0011：**超时以系统 Intent 入事件流**。也就是说，超时不是「服务端
 * 直接改状态」，而是构造一条 `actor: 'system'` 的 Intent，与玩家操作走**完全相同**
 * 的处理链（去重 → 引擎校验 → 产出事件 → reduce → 哈希 → 回放 → 广播）。
 * 客户端因此拿到的仍是一串标准 `GameEvent[]` + `stateHash`，reduce 出来的结果与服务端一致。
 *
 * ⚠️ **计时单位是回合，不是阶段**：一个回合内只要有任何**被接受**的操作就重新计时，
 * 整个回合都无操作才触发超时。按阶段计时会让每回合的时限变成 6×30s，且架空
 * 「阶段不可跳过」的语义。
 *
 * 时钟与调度器均外部注入 —— core 内禁止读时钟；会话层可以读，但必须可注入才能单测。
 */

/** 最小调度器接口 —— 只暴露「延时执行」与「取消」两项能力，便于测试注入假实现。 */
export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface TurnTimerDeps {
  now(): number;
  scheduler: Scheduler;
  /**
   * 超时后要做的事 —— 由会话层注入（构造并提交系统 Intent）。
   *
   * ⚠️ **必须同步**：本回调由定时器直接驱动，一旦引入 `await` 就会把「检查超时」
   * 与「提交 Intent」之间撕开缝隙，两名玩家同时超时时会产生交错。见 ADR-0011。
   */
  onTimeout(): void;
  /** 回合时限，默认 `TURN_TIMEOUT_MS`（ADR-0010）。 */
  timeoutMs?: number;
}

/**
 * 单回合倒计时。语义极简：只回答「距离本回合超时还有多久」，
 * 不关心当前是谁的回合、也不碰 `GameState` —— 那些是会话层的职责。
 */
export class TurnTimer {
  private readonly deps: TurnTimerDeps & { timeoutMs: number };
  private handle: unknown = null;
  private deadline = 0;

  constructor(deps: TurnTimerDeps) {
    this.deps = { timeoutMs: TURN_TIMEOUT_MS, ...deps };
  }

  /** 本回合的时限（毫秒）。 */
  get timeoutMs(): number {
    return this.deps.timeoutMs;
  }

  /**
   * 开始 / 重新计时。
   *
   * 重复调用安全：内部先 `clear` 再设，不会叠加出多个定时器 —— 若叠加，
   * 一个回合内会触发多次 `turn:end`，回合会被连推好几格。
   */
  arm(): void {
    this.clear();
    this.deadline = this.deps.now() + this.deps.timeoutMs;
    this.handle = this.deps.scheduler.setTimeout(() => {
      this.handle = null;
      this.deadline = 0;
      this.deps.onTimeout();
    }, this.deps.timeoutMs);
  }

  /** 停止计时。未计时时为空操作。 */
  clear(): void {
    if (this.handle !== null) {
      this.deps.scheduler.clearTimeout(this.handle);
      this.handle = null;
    }
    this.deadline = 0;
  }

  /** 是否正在计时。 */
  get armed(): boolean {
    return this.handle !== null;
  }

  /** 计时的截止时刻（绝对时间）；未计时为 `0`。供界面显示倒计时用。 */
  get deadlineAt(): number {
    return this.deadline;
  }
}

/** 生产调度器 —— 直接用宿主环境的定时器。 */
export const hostScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
