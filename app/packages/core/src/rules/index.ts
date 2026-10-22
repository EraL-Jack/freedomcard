/**
 * 规则注册表 —— 一个机制一个文件，经本表插拔。
 *
 * 扩展判据：新增规则 = 新增文件 + 在这里加一行。
 * 若某次扩展的 diff 触及了**既有规则文件的内部实现**，视为架构违规，必须重构。
 *
 * 每个 Intent 类型与这里的键一一对应；未注册的类型由 `applyIntent`
 * 统一返回 `NOT_IMPLEMENTED`（拒绝而非静默忽略，便于客户端区分「没做」和「不允许」）。
 */

import { register } from '../registry.js';

import { attackRule } from './attack.js';
import { chargeRule } from './charge.js';
import { commanderAttackRule } from './commander-attack.js';
import { concedeRule } from './concede.js';
import { drawRule } from './draw.js';
import { effectActivateRule, effectChooseRule } from './effect.js';
import { mulliganRule } from './mulligan.js';
import { phaseRule } from './phase.js';
import { playRule } from './play.js';
import { startRule } from './start.js';
import { turnEndRule } from './turn-end.js';

/** Intent 类型常量 —— 禁止在业务代码里写字符串字面量。 */
export const INTENTS = {
  start: 'game:start',
  mulligan: 'mulligan',
  phaseAdvance: 'phase:advance',
  charge: 'charge:put',
  play: 'card:play',
  attack: 'attack:declare',
  /** 指挥官攻击 —— docs/16 §6.1：每战斗阶段一次，基础 1 点打脸（可被伤害加成提升）。 */
  commanderAttack: 'commander:attack',
  /** 手动抽牌 —— Era 2026-10-18：抽牌阶段点击牌组触发。 */
  draw: 'card:draw',
  /** 效果系统（ADR-0023）：发动卡面效果 / 回答待定选择。 */
  effectActivate: 'effect:activate',
  effectChoose: 'effect:choose',
  turnEnd: 'turn:end',
  concede: 'game:concede',
} as const;

export type IntentType = (typeof INTENTS)[keyof typeof INTENTS];

register(INTENTS.start, startRule);
register(INTENTS.mulligan, mulliganRule);
register(INTENTS.phaseAdvance, phaseRule);
register(INTENTS.charge, chargeRule);
register(INTENTS.play, playRule);
register(INTENTS.attack, attackRule);
register(INTENTS.commanderAttack, commanderAttackRule);
register(INTENTS.draw, drawRule);
register(INTENTS.effectActivate, effectActivateRule);
register(INTENTS.effectChoose, effectChooseRule);
register(INTENTS.turnEnd, turnEndRule);
register(INTENTS.concede, concedeRule);

export { attackRule, chargeRule, commanderAttackRule, concedeRule, drawRule, mulliganRule, phaseRule, playRule, startRule, turnEndRule };
export { drawForPhase } from './draw.js';
export { drawCountFor } from './phase.js'; // issue #109：定义搬去 phase，避免与 draw 循环依赖
export { shouldAutoAdvanceDraw } from './phase.js'; // issue #139：0 张自动推进的判定，单点定义
export { PHASE_ORDER, maxCostForTurn } from './phase.js';
