import { useState } from 'react';

import { MAIN_DECK_SIZE, MAX_COPIES } from '@app/shared';

import { CARD_POOL } from '@app/shared/cards';

import CardTile from './CardTile.js';

/**
 * 卡组编辑 —— B1 页面清单要求「需要」，B1 补充 2 要求**支持多个卡组保存**。
 *
 * ⚠️ **当前尚未接入开局**：服务端开局桥取的是 `deck-pool.ts` 的 Demo 卡组
 * （ADR-0018 的占位数据）。本界面可以正常编辑与保存卡组，
 * 但「把玩家自己的卡组交给服务端」需要一条卡组提交协议 —— 那是 Era 的
 * 输入范围（卡组怎么交给服务端、什么时候交），故先留接口不做，见 `docs/01` §1.3。
 */

interface Deck {
  id: string;
  name: string;
  /** defId → 张数。 */
  cards: Record<string, number>;
}

const LS_DECKS = 'fc.decks';

function load(): Deck[] {
  try {
    const raw = localStorage.getItem(LS_DECKS);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Deck[]) : [];
  } catch {
    return [];
  }
}

function save(decks: Deck[]): void {
  localStorage.setItem(LS_DECKS, JSON.stringify(decks));
}

const POOL = Object.values(CARD_POOL).filter((c) => c.type !== 'commander');

export default function DeckScreen({ onBack }: { onBack: () => void }): React.JSX.Element {
  const [decks, setDecks] = useState<Deck[]>(load);
  const [active, setActive] = useState<string | null>(() => load()[0]?.id ?? null);

  const deck = decks.find((d) => d.id === active) ?? null;
  const total = deck ? Object.values(deck.cards).reduce((a, b) => a + b, 0) : 0;

  const commit = (next: Deck[]): void => {
    setDecks(next);
    save(next);
  };

  const create = (): void => {
    const d: Deck = { id: String(Date.now()), name: `卡组 ${decks.length + 1}`, cards: {} };
    commit([...decks, d]);
    setActive(d.id);
  };

  const remove = (id: string): void => {
    const next = decks.filter((d) => d.id !== id);
    commit(next);
    if (active === id) setActive(next[0]?.id ?? null);
  };

  /** 增减一张；同名上限 `MAX_COPIES`，达上限后不再增加。 */
  const bump = (defId: string, delta: number): void => {
    if (!deck) return;
    const n = Math.min(MAX_COPIES, Math.max(0, (deck.cards[defId] ?? 0) + delta));
    const cards = { ...deck.cards };
    if (n === 0) delete cards[defId];
    else cards[defId] = n;
    commit(decks.map((d) => (d.id === deck.id ? { ...d, cards } : d)));
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-3 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">编辑卡组</h1>
        <button type="button" className="rounded border border-slate-700 px-3 py-2" onClick={onBack}>
          返回
        </button>
      </header>

      <section className="flex flex-wrap items-center gap-2">
        {decks.map((d) => (
          <button
            key={d.id}
            type="button"
            className={`rounded px-3 py-2 text-sm ${d.id === active ? 'bg-cyan-800' : 'bg-slate-800'}`}
            onClick={() => setActive(d.id)}
          >
            {d.name}
          </button>
        ))}
        <button type="button" className="rounded bg-emerald-800 px-3 py-2 text-sm" onClick={create}>
          新建卡组
        </button>
        {deck ? (
          <button
            type="button"
            className="rounded bg-rose-900 px-3 py-2 text-sm"
            onClick={() => remove(deck.id)}
          >
            删除当前
          </button>
        ) : null}
      </section>

      {deck ? (
        <p className="text-sm text-slate-400">
          {deck.name} · <span data-testid="deck-total">{total}</span> / {MAIN_DECK_SIZE} 张
          <span className="ml-2 text-xs">（同名上限 {MAX_COPIES}）</span>
        </p>
      ) : (
        <p className="text-sm text-slate-400">还没有卡组，点「新建卡组」开始。</p>
      )}

      {deck ? (
        <section className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {POOL.map((def) => {
            const n = deck.cards[def.defId] ?? 0;
            return (
              <div key={def.defId} className="rounded border border-slate-800 p-2">
                <CardTile
                  name={def.name}
                  cost={def.cost}
                  power={def.power}
                  kind={def.type}
                  text={def.text}
                  selected={n > 0}
                />
                <div className="mt-1 flex items-center justify-between">
                  <button
                    type="button"
                    className="rounded bg-slate-700 px-2 py-1 text-xs"
                    onClick={() => bump(def.defId, -1)}
                    disabled={n === 0}
                  >
                    −
                  </button>
                  <span className="text-sm">{n}</span>
                  <button
                    type="button"
                    className="rounded bg-slate-700 px-2 py-1 text-xs"
                    onClick={() => bump(def.defId, 1)}
                    disabled={n >= MAX_COPIES}
                  >
                    ＋
                  </button>
                </div>
              </div>
            );
          })}
        </section>
      ) : null}

      <p className="mt-auto text-[11px] text-slate-500">
        卡组保存于本机浏览器；尚未接入开局（服务端当前使用 Demo 占位卡组）。
      </p>
    </main>
  );
}
