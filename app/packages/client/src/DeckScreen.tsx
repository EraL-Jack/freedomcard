import { useState } from 'react';

import { MAIN_DECK_SIZE, MAX_COPIES } from '@app/shared';

import { CARD_POOL } from '@app/shared/cards';

import CardTile from './CardTile.js';
import { deckTotal, isDeckComplete, loadActiveDeckId, loadDecks, saveDecks, saveActiveDeckId, type SavedDeck } from './decks.js';

/**
 * 卡组编辑 —— B1 页面清单要求「需要」，B1 补充 2 要求**支持多个卡组保存**。
 *
 * D-141：编辑好的卡组已接入开局 —— 正好 30 张的卡组可在**建房/加入时**与
 * **准备页**选用（`HomeScreen` / `WaitingRoom` 的下拉），服务端校验后按它装配主卡组。
 * 指挥官不随卡组提交：仍由席位阵营决定。
 */

const POOL = Object.values(CARD_POOL).filter((c) => c.type !== 'commander');

export default function DeckScreen({ onBack }: { onBack: () => void }): React.JSX.Element {
  const [decks, setDecks] = useState<SavedDeck[]>(loadDecks);
  const [active, setActive] = useState<string | null>(() => loadDecks()[0]?.id ?? null);
  /** 当前用于开局的卡组（D-141）—— 与主界面 / 准备页共用同一个 localStorage 键。 */
  const [inUseId, setInUseId] = useState(loadActiveDeckId);

  const deck = decks.find((d) => d.id === active) ?? null;
  const total = deck ? deckTotal(deck) : 0;
  const canUse = deck !== null && isDeckComplete(deck);

  const commit = (next: SavedDeck[]): void => {
    setDecks(next);
    saveDecks(next);
  };

  const create = (): void => {
    const d: SavedDeck = { id: String(Date.now()), name: `卡组 ${decks.length + 1}`, cards: {} };
    commit([...decks, d]);
    setActive(d.id);
  };

  const remove = (id: string): void => {
    const next = decks.filter((d) => d.id !== id);
    commit(next);
    if (active === id) setActive(next[0]?.id ?? null);
    // 删掉的正好是「开局使用中」→ 清掉选择，回落到阵营默认卡组
    if (inUseId === id) {
      saveActiveDeckId('');
      setInUseId('');
    }
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
        <button
          type="button"
          className="rounded bg-emerald-800 px-3 py-2 text-sm"
          onClick={create}
          data-testid="deck-new"
        >
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
        {/* D-141：这里直接把当前编辑的卡组设为「开局使用」，省得回主界面再选一次 */}
        {deck && canUse ? (
          inUseId === deck.id ? (
            <span
              className="rounded bg-emerald-900 px-3 py-2 text-sm text-emerald-200"
              data-testid="deck-in-use"
            >
              开局使用中
            </span>
          ) : (
            <button
              type="button"
              className="rounded bg-cyan-800 px-3 py-2 text-sm"
              onClick={() => {
                saveActiveDeckId(deck.id);
                setInUseId(deck.id);
              }}
              data-testid="use-deck"
            >
              设为开局卡组
            </button>
          )
        ) : deck ? (
          <span className="px-1 text-xs text-slate-500">
            凑满 {MAIN_DECK_SIZE} 张才能设为开局卡组
          </span>
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
                    data-testid={`deck-remove-${def.defId}`}
                  >
                    −
                  </button>
                  <span className="text-sm">{n}</span>
                  <button
                    type="button"
                    className="rounded bg-slate-700 px-2 py-1 text-xs"
                    onClick={() => bump(def.defId, 1)}
                    disabled={n >= MAX_COPIES}
                    data-testid={`deck-add-${def.defId}`}
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
        卡组保存于本机浏览器；凑满 {MAIN_DECK_SIZE} 张即可在开局时选用（指挥官仍由阵营决定）。
      </p>
    </main>
  );
}
