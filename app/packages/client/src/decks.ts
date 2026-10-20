/**
 * 本地卡组存取（B1 补充 2：支持多个卡组保存）+ 开局提交（D-141）。
 *
 * ## 一套卡组 = 30 张主卡 + 1 位指挥官（D-184 / ADR-0042）
 *
 * Era 2026-10-20：「我的设计里不存在阵营之分，卡池可以混选……卡组编辑的时候还要有个
 * 地方选指挥官。」于是这里不再有「阵营」这一层：卡组自己带着指挥官，
 * 提交给服务端时两样一起发（`deck` + `commander`）。
 *
 * 存 `defId → 张数` 便于编辑器增减；提交时展开成 30 个 `defId`。
 *
 * ⚠️ localStorage 里的内容可能被手改或来自旧版本，`loadDecks` 必须做形状校验，
 * 坏数据一律丢弃 —— 读卡组不能把整个界面炸掉。**旧卡组没有 `commander` 字段**，
 * 迁移策略是补默认指挥官，而不是丢掉玩家的 30 张。
 */

import { MAIN_DECK_SIZE } from '@app/shared/constants';
import { COMMANDER_IDS, BASIC_DECKS, DEFAULT_COMMANDER_ID, basicDeckBySlug } from '@app/shared/default-decks';

export interface SavedDeck {
  id: string;
  name: string;
  /** 本套卡组使用的指挥官 `defId`（D-184）。 */
  commander: string;
  /** defId → 张数。 */
  cards: Record<string, number>;
}

/** 一套可以直接拿去开局的「卡组 + 指挥官」（我的卡组与基础卡组都归一到这个形状）。 */
export interface SelectionOption {
  /** 下行到 `fc.activeDeckId` 的值：`basic:<slug>` 或我的卡组 id。 */
  value: string;
  label: string;
  /** 展开后的 30 个 `defId`。 */
  deck: string[];
  commander: string;
  /** 是否满 30 张（基础卡组恒为 true）。 */
  complete: boolean;
}

const LS_DECKS = 'fc.decks';
const LS_ACTIVE = 'fc.activeDeckId';

/** 基础卡组在选择列表里的前缀 —— 与我的卡组 id 不冲突（id 是时间戳/`basic-*`）。 */
const BASIC_PREFIX = 'basic:';

/** 读全部卡组；坏数据丢弃，缺指挥官的旧数据补默认（D-184 迁移）。 */
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
      // 旧卡组没有 commander；有但不认识（卡池改动 / 手改）也回落 —— 不能把非法 id 发给服务端。
      const commander =
        typeof d.commander === 'string' && COMMANDER_IDS.includes(d.commander)
          ? d.commander
          : DEFAULT_COMMANDER_ID;
      return [{ id: d.id, name: d.name, commander, cards }];
    });
  } catch {
    return [];
  }
}

export function saveDecks(decks: SavedDeck[]): void {
  localStorage.setItem(LS_DECKS, JSON.stringify(decks));
}

/**
 * 首次使用：预置三套基础卡组（D-169）。
 *
 * 判定依据是 **`fc.decks` 这个键存在与否**，而不是「读出来是空数组」——
 * 玩家主动把卡组全删光也是一种有效状态，下次进来不该又冒出三套。
 * 三套配方来自 `@app/shared/default-decks`，与服务端未选卡组时的回退同源。
 */
export function ensureDefaultDecks(): SavedDeck[] {
  if (localStorage.getItem(LS_DECKS) !== null) return loadDecks();
  const seeded: SavedDeck[] = BASIC_DECKS.map((d) => ({
    id: `basic-${d.slug}`,
    name: d.name,
    commander: d.commander,
    cards: { ...d.recipe },
  }));
  saveDecks(seeded);
  return seeded;
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

/**
 * 可选项列表 —— **只列我保存的卡组**（D-184）。
 *
 * 为什么不再额外列「基础卡组」：三套基础卡组在首次进入时已经写进 `fc.decks`
 * （`basic-blade` / `basic-frost` / `basic-star`），再列一份虚拟的会变成
 * **同一个东西出现两次**，而且玩家改了其中一份、另一份还是原样 —— 说不清哪个生效。
 *
 * 唯一的例外是「一套都没有」（玩家把卡组删光了）：此时给一个兜底选项，
 * 否则下拉是空的、`<select>` 显示空白，玩家会以为坏了。服务端也认这套兜底。
 */
export function listSelectionOptions(): SelectionOption[] {
  const mine: SelectionOption[] = loadDecks().map((d) => ({
    value: d.id,
    label: d.name,
    deck: deckDefIds(d),
    commander: d.commander,
    complete: isDeckComplete(d),
  }));
  return mine.length > 0 ? mine : [fallbackSelection()];
}

/** 按选择值解析出一套可开局的卡组；找不到 / 不完整时返回 `null`。 */
export function resolveSelection(value: string): SelectionOption | null {
  const opt = listSelectionOptions().find((o) => o.value === value);
  return opt && opt.complete ? opt : null;
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
 * 调用方此时应回落到**第一套基础卡组**（而不是「阵营默认」，阵营已不存在）。
 */
export function activeSelection(): SelectionOption | null {
  return resolveSelection(loadActiveDeckId());
}

/** 兜底：第一套基础卡组 —— 服务端在什么都没收到时也落到这一套（ADR-0042）。 */
export function fallbackSelection(): SelectionOption {
  const first = basicDeckBySlug(BASIC_DECKS[0]!.slug)!;
  return {
    value: `${BASIC_PREFIX}${first.slug}`,
    label: `${first.name}（基础）`,
    deck: [...first.deck],
    commander: first.commander,
    complete: true,
  };
}

/**
 * 真正要提交的那一套 —— 选中的可用卡组，否则第一套基础卡组。
 *
 * ⚠️ 永远不发 `undefined`：服务端虽然能补默认，但「谁替谁做了决定」这种不确定性
 * 在联机里最难查（一方看到界面写 A、实际开局是 B）。客户端始终发确定的一套。
 */
export function selectionForPlay(): SelectionOption {
  return activeSelection() ?? fallbackSelection();
}
