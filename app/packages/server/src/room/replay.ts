import type { GameEvent, Intent } from '@app/shared';

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
  intents: Intent[];
  /** 每个 Intent 对应产出的一组事件。 */
  events: GameEvent[][];
  /** 每次结算后的状态哈希链，用于回放逐帧比对。 */
  hashChain: string[];
  startedAt: number;
  endedAt: number | null;
  result: unknown;
}

export class ReplayRecorder {
  private readonly record: ReplayRecord;

  constructor(startedAt: number) {
    this.record = { intents: [], events: [], hashChain: [], startedAt, endedAt: null, result: null };
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
    };
  }
}
