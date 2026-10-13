import { useState } from 'react';

import DeckScreen from './DeckScreen.js';
import HomeScreen from './HomeScreen.js';
import TableScreen from './TableScreen.js';
import { useRoom } from './useRoom.js';

/**
 * 视图切换 —— 页面清单严格按 B1：
 *  - **主界面**：加入房间 / 创建房间 / 编辑卡组（B1 补充 1）
 *  - **对战桌**：创建 / 加入房间即进入（B1 补充 3）
 *  - **卡组编辑**：需要，支持多个卡组保存（B1 补充 2）
 *
 * ⚠️ B1 明确说**不需要**大厅页、房间等待页、结算页、排行榜 —— 故一律不建。
 *
 * 没有路由库：三个视图就一个 `useState` 足够，引入 router 只会增加首屏体积。
 * 「在对战桌里」由 `session.room` 决定，而不是单独的 view 字段 ——
 * 房间存在就该在对战桌，二者不该各持一份真相。
 */
export default function App(): React.JSX.Element {
  const session = useRoom();
  const [view, setView] = useState<'home' | 'deck'>('home');

  if (view === 'deck') {
    return <DeckScreen onBack={() => setView('home')} />;
  }
  if (session.room) {
    return <TableScreen session={session} />;
  }
  return <HomeScreen session={session} onEditDeck={() => setView('deck')} />;
}
