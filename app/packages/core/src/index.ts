export { nextFloat, nextInt, shuffle, seedFrom, initialRngCursor, advanceCursor, type RngStep } from './rng.js';
export {
  createInitialState,
  emptyZones,
  makeUid,
  commanderUid,
  activePlayer,
  opponentOf,
  ZONES,
  type InitialStateOptions,
} from './state.js';
export { applyIntent, reduce, stateHash, canonicalize } from './engine.js';
export { rules, register, get, type RuleHandler } from './registry.js';
export { replay, isDeterministic, type ReplayDeps, type ReplayOutcome } from './replay.js';
export { checkDeck } from './deck.js';
export { decideAiMove, type AiMove } from './ai.js';
export { INTENTS, type IntentType } from './rules/index.js';
// issue #109：`drawCountFor` 也导出给客户端做「该抽几张」的可见性判定（同一个函数，不分叉）
// issue #139 / D-287：`shouldAutoAdvanceDraw` 同理 —— 0 张自动推进的判定只此一处
export { PHASE_ORDER, maxCostForTurn, drawCountFor, shouldAutoAdvanceDraw } from './rules/phase.js';
export * from './ops.js';
