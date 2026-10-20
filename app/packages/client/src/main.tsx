import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.js';
import { ensureDefaultDecks } from './decks.js';
import './style.css';

// 首次打开就在本地写入三套基础卡组（D-169）。
//
// 为什么放在入口而不是 `DeckScreen`：主界面与准备页的下拉都只读 `loadDecks()`，
// 玩家若从不进编辑页，就永远看不到那三套 —— 等于「默认卡组」没准备好。
// 幂等：`fc.decks` 已存在时直接返回，不覆盖玩家自己的卡组。
ensureDefaultDecks();

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root 未找到');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
