/**
 * 会话层（房间 / 席位 / Intent 处理链）。
 *
 * 与玩法无关：本目录不出现任何卡牌、费用、回合阶段之类的业务概念。
 * 规则的接入点是 `pipeline.ts` 的 `EnginePort`，生产环境注入 `@app/core`。
 */
export * from './types.js';
export * from './room.js';
export * from './seq-guard.js';
export * from './replay.js';
export * from './pipeline.js';
