/**
 * 本地卡组存取（B1 补充 2：支持多个卡组保存）+ 开局提交（D-141）。
 *
 * 卡组只存主卡组 30 张，**不含指挥官**：指挥官由席位阵营决定。
 * 存 `defId → 张数` 便于编辑器增减；提交给服务端时展开成 30 个 `defId`。
 *
 * ⚠️ localStorage 里的内容可能被手改或来自旧版本，`loadDecks` 必须做形状校验，
 * 坏数据一律丢弃 —— 读卡组不能把整个界面炸掉。
 */

import { MAIN_DECK_SIZE } from '@app/shared';

export interface SavedDeck {
  id: string;
  name: string;
  /** defId → 张数。 */
  cards: Record<string, number>;
}

const LS_DECKS = 'fc.decks';
const LS_ACTIVE = 'fc.activeDeckId';

/** 读全部卡组；坏数据丢弃。 */
export function loadDecks(): SavedDeck[] {
  try {
    const raw = localStorage.getItem(LS_DECKS);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((x): SavedDeck[] => {
      if (typeof x !== 'object' || x === null) return [];
      const d = x as Partial<SavedDeck>;
      if (typeof d.id !== 'string' || typeof d.name !== 'string') return [];
      const cards: Record<string, number> = {};
      if (typeof d.cards === 'object' && d.cards !== null) {
        for (const [k, v] of Object.entries(d.cards)) {
          if (typeof v === 'number' && Number.isInteger(v) && v > 0) cards[k] = v;
        }
      }
      return [{ id: d.id, name: d.name, cards }];
    });
  } catch {
    return [];
  }
}

export function saveDecks(decks: SavedDeck[]): void {
  localStorage.setItem(LS_DECKS, JSON.stringify(decks));
}

export function deckTotal(deck: SavedDeck): number {
  return Object.values(deck.cards).reduce((a, b) => a + b, 0);
}

/** 是否可提交：正好 30 张。 */
export function isDeckComplete(deck: SavedDeck): boolean {
  return deckTotal(deck) === MAIN_DECK_SIZE;
}

/** 展开成 `defId` 列表（顺序无关，服务端会洗牌）。 */
export function deckDefIds(deck: SavedDeck): string[] {
  return Object.entries(deck.cards).flatMap(([defId, n]) =>
    Array.from({ length: n }, () => defId),
  );
}

export function loadActiveDeckId(): string {
  return localStorage.getItem(LS_ACTIVE) ?? '';
}

export function saveActiveDeckId(id: string): void {
  if (id) localStorage.setItem(LS_ACTIVE, id);
  else localStorage.removeItem(LS_ACTIVE);
}

/**
 * 当前选中的可用卡组 —— 找不到 / 不完整（≠30 张）时返回 `null`，
 * 调用方此时应使用阵营默认卡组，避免把非法卡组发给服务端。
 */
export function activeDeck(): SavedDeck | null {
  const id = loadActiveDeckId();
  if (!id) return null;
  const deck = loadDecks().find((d) => d.id === id);
  return deck && isDeckComplete(deck) ? deck : null;
}

/** 当前选中卡组的 `defId` 列表；无可用选择时返回 `undefined`（= 阵营默认）。 */
export function activeDeckDefIds(): string[] | undefined {
  const deck = activeDeck();
  return deck ? deckDefIds(deck) : undefined;
}
