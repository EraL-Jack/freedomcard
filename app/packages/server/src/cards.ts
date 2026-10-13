/**
 * 卡池 —— **唯一来源已迁至 `@app/shared/src/cards.ts`**（ADR-0020）。
 *
 * 迁移理由：卡池必须被**两端消费** —— 服务端用它做卡组校验与结算，
 * 客户端用它渲染卡面（名字 / 费用 / 力量值）。它是**数据**而非玩法规则，
 * 放在共享层不违反「不发明需求」的纪律。
 *
 * 本文件仅作 re-export，以免打断既有 import 路径（`./cards.js`）与
 * `cards.test.ts` 的调用点。
 */
export { CARD_POOL, PLACEHOLDER_CARD_IDS, isBladeCard } from '@app/shared/cards';
