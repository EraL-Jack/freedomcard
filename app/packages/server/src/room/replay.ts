import type { GameEvent, Intent } from '@app/shared';

import type { SeedSetup } from './session.js';

/** 回放里的装配参数 —— 与 `SeedSetup` 同形（避免让 server 内部类型泄漏进协议层）。 */
export type ReplaySetup = SeedSetup;

/**
 * 一局的完整记录 —— BO3 里每小局一份。
 *
 * 为什么必须分开：`markStart` 每局都会调一次，如果 `intents` 继续往同一个数组里 push，
 * 记录里就会出现**两个 `game:start`**，重放到第二个时被规则拒绝（「对局已开始」），
 * 于是整份文件不可重放。实测在 4 份历史文件上复现过（D-175）。
 */
export interface ReplayRound {
  setup: ReplaySetup;
  initialHash: string;
  intents: Intent[];
  events: GameEvent[][];
  hashChain: string[];
}

/**
 * 一局的回放记录。
 *
 * 粒度：**种子 + Intent 序列**（比只记 Event 更严格 —— 重跑时能同时验证 handler 与 reduce）。
 * `intents[]` **必须包含系统 Intent**（超时等由服务端构造的），否则回放会缺步、对不上终局哈希。
 *
 * 落盘是 IO，**禁止出现在 Intent 处理链内**（ADR-0011：链上禁止 await）。
 * 本类只在内存里同步记录，写文件由调用方在整条链完成之后异步执行。
 */
export interface ReplayRecord {
  /**
   * 开局装配（D-159）—— seed / 座位 / 卡组 / 指挥官。
   *
   * 没有它，这份记录**无法被重放**：只有 Intent 序列与事件，不知道从哪个状态出发。
   * 由 `markStart` 在开局那一步写入；BO3 每一小局各自重置。
   *
   * 📌 多局时这里是**最后一局**的装配，前几局在 `rounds` 里（D-175）。
   */
  setup: ReplaySetup | null;
  /** 开局状态哈希 —— 重放时第一帧的比对基准。 */
  initialHash: string | null;
  intents: Intent[];
  /** 每个 Intent 对应产出的一组事件。 */
  events: GameEvent[][];
  /** 每次结算后的状态哈希链，用于回放逐帧比对。 */
  hashChain: string[];
  /**
   * **已经结束的前几局**（BO3 才有；单局时为空数组）。
   *
   * 顺序即局序，顶层那三个数组始终是**当前/最后一局**。
   * 拆分理由见 `ReplayRound` 的注释：混在一起会让重放在第二个 `game:start` 处失败。
   */
  rounds: ReplayRound[];
  startedAt: number;
  endedAt: number | null;
  result: unknown;
}

export class ReplayRecorder {
  private readonly record: ReplayRecord;

  constructor(startedAt: number) {
    this.record = {
      setup: null,
      initialHash: null,
      intents: [],
      events: [],
      hashChain: [],
      rounds: [],
      startedAt,
      endedAt: null,
      result: null,
    };
  }

  /**
   * 记录开局装配（D-159）。在发出 `game:start` **之前**调用 ——
   * 之后每一步都能从这份参数重建成同一初始状态。
   *
   * BO3 第 2、3 局会再调一次：此时先把**上一局归档进 `rounds`** 再把三数组清空，
   * 否则两个 `game:start` 会挤在同一段序列里（D-175）。
   */
  markStart(setup: ReplaySetup, initialHash: string): void {
    if (this.record.setup !== null) {
      this.record.rounds.push({
        setup: this.record.setup,
        initialHash: this.record.initialHash ?? '',
        intents: this.record.intents,
        events: this.record.events,
        hashChain: this.record.hashChain,
      });
      this.record.intents = [];
      this.record.events = [];
      this.record.hashChain = [];
    }
    this.record.setup = setup;
    this.record.initialHash = initialHash;
  }

  /** 同步记录一步结算。系统 Intent 也要走这里。 */
  recordStep(intent: Intent, events: GameEvent[], hash: string): void {
    this.record.intents.push(intent);
    this.record.events.push(events);
    this.record.hashChain.push(hash);
  }

  current(): Readonly<ReplayRecord> {
    return this.record;
  }

  /** 结束并产出快照（浅拷贝，防止后续写入污染已落盘数据）。 */
  finish(result: unknown = null, endedAt: number = Date.now()): ReplayRecord {
    this.record.endedAt = endedAt;
    this.record.result = result;
    return {
      ...this.record,
      intents: [...this.record.intents],
      events: [...this.record.events],
      hashChain: [...this.record.hashChain],
      rounds: this.record.rounds.map((r) => ({
        ...r,
        intents: [...r.intents],
        events: [...r.events],
        hashChain: [...r.hashChain],
      })),
    };
  }
}
