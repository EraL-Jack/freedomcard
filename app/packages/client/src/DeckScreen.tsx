import { useMemo, useState } from 'react';

import type { CardType } from '@app/shared';
import { MAIN_DECK_SIZE, MAX_COPIES } from '@app/shared/constants';
import { CARD_POOL } from '@app/shared/cards';
import { COMMANDER_IDS, DEFAULT_COMMANDER_ID, deckRecipeProblems } from '@app/shared/default-decks';

import CardTile from './CardTile.js';
import {
  deckTotal,
  ensureDefaultDecks,
  fallbackSelection,
  isDeckComplete,
  loadActiveDeckId,
  loadDecks,
  saveActiveDeckId,
  saveDecks,
  type SavedDeck,
} from './decks.js';

/**
 * 卡组编辑 —— B1 页面清单要求「需要」，B1 补充 2 要求支持多个卡组保存。
 *
 * ## 结构（Era 2026-10-20 三条要求 / D-169）
 *
 * 1. **首次进入预置三套基础卡组**（炎刃 / 霜律 / 星轨），配方与服务端回退同源
 *    （`@app/shared/default-decks`），不用再从 45 张里手动凑。
 * 2. 分**上下两块**：上面是已选（带数量、可加减），下面是待选（简化条目 + 右侧加减，
 *    点条目看详情，详情里同样能加减）。
 * 3. 统计并校验：总数 X/30 + 三类张数（随从 / 法术 / 设置），不合法时给人话提示。
 *
 * ## 详情为什么是浮层而不是行内展开
 *
 * 移动端（390×844）上，上下两块已经吃掉整屏；行内展开会把待选区挤到只剩一两行，
 * 展开的内容基本看不见。改成浮层后两块高度不受影响，桌面居中、手机贴底。
 *
 * ## 保留的 E2E 锚点（不能改名）
 *
 * `deck-new` / `deck-add-<defId>` / `deck-remove-<defId>` / `deck-total` /
 * `use-deck` / `deck-in-use` —— `e2e/deck.spec.ts` 依赖它们。
 * **已选区的加减用 `deck-sel-*` 前缀**：同一个 `defId` 在两个区都有按钮，
 * 若共用 testId，`getByTestId` 会命中两个元素并触发 strict mode 失败。
 */

const POOL = Object.values(CARD_POOL).filter((c) => c.type !== 'commander');

/**
 * 指挥官候选（D-184）—— 顺序与 `COMMANDER_IDS` 一致。
 *
 * 为什么从 `COMMANDER_IDS` 而不是直接 filter 卡池：卡池顺序是「按卡表转录」的顺序，
 * 若哪天新增一张指挥官卡放在中间，界面顺序会莫名其妙地跳；候选名单应是**显式**的。
 */
const COMMANDERS = COMMANDER_IDS.flatMap((id) => (CARD_POOL[id] ? [CARD_POOL[id]!] : []));

/** 待选列表排序：费用升序 → 卡名 —— 与卡表习惯一致，且同费卡放一起便于比较。 */
const SORTED_POOL = [...POOL].sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name, 'zh'));

/** 类型中文标签（与 `CardTile` 的 KIND_TAG 同口径，「设置」= 设置法术）。 */
const KIND_LABEL: Readonly<Record<CardType, string>> = {
  commander: '指挥官',
  minion: '随从',
  spell: '法术',
  continuous: '设置',
};

/** 卡组按钮上的短名 —— 「炎刃 · 中速除外」→「炎刃」，否则移动端标签要占三行。 */
function shortName(name: string): string {
  return name.split(' · ')[0] ?? name;
}

export default function DeckScreen({ onBack }: { onBack: () => void }): React.JSX.Element {
  // 首次进入会写入三套基础卡组；已有 `fc.decks`（哪怕被删成空数组）则原样读取。
  const [decks, setDecks] = useState<SavedDeck[]>(ensureDefaultDecks);
  const [active, setActive] = useState<string | null>(() => loadDecks()[0]?.id ?? null);
  /** 当前用于开局的卡组（D-141）—— 与主界面 / 准备页共用同一个 localStorage 键。 */
  const [inUseId, setInUseId] = useState(loadActiveDeckId);
  /** 详情浮层正在看的卡；`null` = 关闭。 */
  const [detailId, setDetailId] = useState<string | null>(null);
  /** 删除的两段确认（D-172）—— 切换卡组或新建时自动收起，避免「确认删除」跑到别的卡组上。 */
  const [confirmDelete, setConfirmDelete] = useState(false);

  const deck = decks.find((d) => d.id === active) ?? null;
  const total = deck ? deckTotal(deck) : 0;
  const canUse = deck !== null && isDeckComplete(deck);

  /** 三类张数 —— 需求 3 的「检验各种类卡片张数」。 */
  const counts = useMemo(() => {
    const c = { minion: 0, spell: 0, continuous: 0 };
    if (!deck) return c;
    for (const [defId, n] of Object.entries(deck.cards)) {
      const type = CARD_POOL[defId]?.type;
      if (type === 'minion' || type === 'spell' || type === 'continuous') c[type] += n;
    }
    return c;
  }, [deck]);

  /** 合法性问题（与服务端同口径）；空数组 = 可直接开局。 */
  const problems = useMemo(() => (deck ? deckRecipeProblems(deck.cards) : []), [deck]);

  /** 已选列表（按费用排序），只含数量 > 0 的卡；未知 defId 直接丢弃（localStorage 可能被手改）。 */
  const selected = useMemo(() => {
    if (!deck) return [];
    return Object.entries(deck.cards)
      .flatMap(([defId, n]) => {
        const def = CARD_POOL[defId];
        return def ? [{ def, n }] : [];
      })
      .sort((a, b) => a.def.cost - b.def.cost || a.def.name.localeCompare(b.def.name, 'zh'));
  }, [deck]);

  const commit = (next: SavedDeck[]): void => {
    setDecks(next);
    saveDecks(next);
  };

  /**
   * 换当前这套卡组的指挥官（D-184）。
   *
   * 只改 `commander` 字段，不动 30 张主卡 —— 卡池不限体系，任何主卡组都能搭任何指挥官
   * （Era：「不存在阵营之分，卡池可以混选」）。
   */
  const setCommander = (defId: string): void => {
    if (!deck) return;
    commit(decks.map((d) => (d.id === deck.id ? { ...d, commander: defId } : d)));
  };

  /**
   * 指挥官按钮的点击（Era 2026-10-20）。
   *
   * - **没选中** → 选它；
   * - **已选中** → 打开详情看效果。
   *
   * 也就是说同一次点击有两种含义，取决于当前状态。这样右上角那个抢注意力的
   * 「看效果」按钮就可以去掉，详情入口仍然在（第二次点击）。
   */
  const pickCommander = (defId: string): void => {
    if (!deck) return;
    if (deck.commander === defId) {
      setDetailId(defId);
      return;
    }
    setCommander(defId);
  };

  /** 不完整时实际会用的那套的名字（回落说明要用它，不能只说「默认」）。 */
  const fallbackName = (): string => fallbackSelection().label;

  const create = (): void => {
    // 新建卡组也要有指挥官（D-184）—— 留空会被服务端判成非法 / 回落，界面还说不出为什么。
    const d: SavedDeck = {
      id: String(Date.now()),
      name: `卡组 ${decks.length + 1}`,
      commander: DEFAULT_COMMANDER_ID,
      cards: {},
    };
    commit([...decks, d]);
    setActive(d.id);
    setDetailId(null);
    setConfirmDelete(false);
  };

  const remove = (id: string): void => {
    const next = decks.filter((d) => d.id !== id);
    commit(next);
    if (active === id) setActive(next[0]?.id ?? null);
    // 删掉的正好是「开局使用中」→ 清掉选择，开局会回落第一套基础卡组（不再有「阵营默认」）
    if (inUseId === id) {
      saveActiveDeckId('');
      setInUseId('');
    }
  };

  /**
   * 增减一张。
   *
   * 两道闸：同名上限 `MAX_COPIES`；**总数 30 为硬上限** —— 加满后不再允许继续加，
   * 否则「换一张卡」会变成「先加到 31 再减」，数字更难看懂。
   */
  const bump = (defId: string, delta: number): void => {
    if (!deck) return;
    const current = deck.cards[defId] ?? 0;
    if (delta > 0 && (current >= MAX_COPIES || total >= MAIN_DECK_SIZE)) return;
    const n = Math.min(MAX_COPIES, Math.max(0, current + delta));
    const cards = { ...deck.cards };
    if (n === 0) delete cards[defId];
    else cards[defId] = n;
    commit(decks.map((d) => (d.id === deck.id ? { ...d, cards } : d)));
  };

  const plusDisabled = (n: number): boolean => n >= MAX_COPIES || total >= MAIN_DECK_SIZE;

  const detailDef = detailId ? CARD_POOL[detailId] : undefined;
  const detailN = detailDef && deck ? (deck.cards[detailDef.defId] ?? 0) : 0;

  return (
    <main className="mx-auto flex h-dvh max-w-3xl flex-col gap-2 p-3">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">编辑卡组</h1>
        <button type="button" className="rounded border border-slate-700 px-3 py-2" onClick={onBack}>
          返回
        </button>
      </header>

      {/* 卡组切换 —— 首次进入就有三套基础卡组 */}
      <section className="flex flex-wrap items-center gap-2">
        {decks.map((d) => (
          <button
            key={d.id}
            type="button"
            className={`max-w-[7rem] truncate rounded px-3 py-1.5 text-sm ${
              d.id === active ? 'bg-cyan-800' : 'bg-slate-800'
            }`}
            onClick={() => {
              setActive(d.id);
              setDetailId(null);
              setConfirmDelete(false);
            }}
            data-testid={`deck-tab-${d.id}`}
            title={d.name}
          >
            {shortName(d.name)}
          </button>
        ))}
        <button
          type="button"
          className="rounded bg-emerald-800 px-3 py-1.5 text-sm"
          onClick={create}
          data-testid="deck-new"
        >
          新建卡组
        </button>
        {/* 删除做两段确认（D-172）—— 误点一次不可恢复：三套基础卡组删掉后不会再生成
            （判据是 `fc.decks` 键存在，删光也算「已初始化」）。同认输的两段式（D-147）。 */}
        {deck ? (
          confirmDelete ? (
            <>
              <button
                type="button"
                className="rounded bg-rose-700 px-3 py-1.5 text-sm"
                onClick={() => {
                  remove(deck.id);
                  setConfirmDelete(false);
                }}
                data-testid="deck-delete-confirm"
              >
                确认删除「{shortName(deck.name)}」
              </button>
              <button
                type="button"
                className="rounded border border-slate-700 px-3 py-1.5 text-sm"
                onClick={() => setConfirmDelete(false)}
                data-testid="deck-delete-cancel"
              >
                取消
              </button>
            </>
          ) : (
            <button
              type="button"
              className="rounded bg-rose-900 px-3 py-1.5 text-sm"
              onClick={() => setConfirmDelete(true)}
              data-testid="deck-delete"
            >
              删除当前
            </button>
          )
        ) : null}
        {/* D-141：这里直接把当前编辑的卡组设为「开局使用」，省得回主界面再选一次 */}
        {deck && canUse ? (
          inUseId === deck.id ? (
            <span
              className="rounded bg-emerald-900 px-3 py-1.5 text-sm text-emerald-200"
              data-testid="deck-in-use"
            >
              开局使用中
            </span>
          ) : (
            <button
              type="button"
              className="rounded bg-cyan-800 px-3 py-1.5 text-sm"
              onClick={() => {
                saveActiveDeckId(deck.id);
                setInUseId(deck.id);
              }}
              data-testid="use-deck"
            >
              设为开局卡组
            </button>
          )
        ) : deck && inUseId === deck.id ? (
          // 已经设为开局，但事后被改到不足 30 张 —— 开局会静默回落到第一套基础卡组，必须说出来。
          <span className="px-1 text-xs text-amber-300" data-testid="deck-fallback-hint">
            这套已设为开局卡组，但现在只有 {total} 张 —— 开局会回落「{fallbackName()}」
          </span>
        ) : deck ? (
          <span className="px-1 text-xs text-slate-500">
            凑满 {MAIN_DECK_SIZE} 张才能设为开局卡组
          </span>
        ) : null}
      </section>

      {deck ? (
        <>
          {/* 指挥官（D-184）—— 一套卡组自带一位，换指挥官就是换这套卡组的打法核心。
              放在统计上方：它比「总张数」更早决定这套牌怎么赢。

              交互（Era 2026-10-20）：**点一下选中，选中的再点一次看效果**。
              原先右上角挂了个「看效果」按钮，视觉上像页面的次级操作、又抢注意力；
              改成「选中态再点」后只留下一排按钮，详情入口也还在（只是藏在第二次点击里）。 */}
          <section className="rounded border border-indigo-900/70 bg-slate-900/60 px-3 py-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs text-slate-400">指挥官（本套卡组自带）</span>
              <span className="text-[11px] text-slate-500">选中的再点一次看效果</span>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {COMMANDERS.map((c) => {
                const on = deck.commander === c.defId;
                return (
                  <button
                    key={c.defId}
                    type="button"
                    className={`rounded px-3 py-1.5 text-sm ${
                      on
                        ? 'bg-indigo-700 text-indigo-50'
                        : 'border border-slate-700 bg-slate-800 text-slate-300 hover:border-indigo-500'
                    }`}
                    onClick={() => pickCommander(c.defId)}
                    data-testid={`deck-commander-${c.defId}`}
                    aria-pressed={on}
                  >
                    {c.name}
                  </button>
                );
              })}
            </div>
          </section>

          {/* 统计与校验 */}
          <section className="rounded border border-slate-800 bg-slate-900/60 px-3 py-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="text-sm font-medium">{deck.name}</span>
              <span className="text-sm text-slate-300">
                <b className="text-base text-slate-100" data-testid="deck-total">
                  {total}
                </b>
                <span className="text-slate-400"> / {MAIN_DECK_SIZE} 张</span>
              </span>
              <span className="text-xs text-slate-400" data-testid="deck-counts">
                随从 {counts.minion} · 法术 {counts.spell} · 设置 {counts.continuous}
              </span>
            </div>
            <p
              className={`mt-0.5 text-xs ${problems.length > 0 ? 'text-amber-300' : 'text-emerald-300'}`}
              data-testid="deck-problems"
            >
              {problems.length > 0 ? problems[0] : '合法，可作为开局卡组'}
            </p>
          </section>

          {/* 上：已选 */}
          <section className="flex max-h-[32vh] min-h-0 flex-col rounded border border-cyan-900/70">
            <h2 className="flex items-center justify-between border-b border-cyan-900/70 px-3 py-1.5 text-xs text-cyan-200">
              <span>
                已选 {selected.length} 种 · {total} 张
              </span>
              {total >= MAIN_DECK_SIZE ? (
                <span className="text-slate-400">已满，减少才能换</span>
              ) : null}
            </h2>
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5" data-testid="deck-selected">
              {selected.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-slate-500">
                  还没选卡 —— 从下面「待选」里点 ＋ 添加
                </p>
              ) : (
                <ul className="space-y-1">
                  {selected.map(({ def, n }) => (
                    <li
                      key={def.defId}
                      className="flex items-center gap-2 rounded bg-slate-800/50 px-2 py-1"
                    >
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left text-sm"
                        onClick={() => setDetailId(def.defId)}
                        data-testid={`deck-sel-row-${def.defId}`}
                      >
                        {def.name}
                      </button>
                      <span className="shrink-0 text-[11px] text-slate-400">
                        {KIND_LABEL[def.type]} · 费{def.cost}
                        {def.type === 'minion' ? ` · 力${def.power}` : ''}
                      </span>
                      <button
                        type="button"
                        className="rounded bg-slate-700 px-2 py-0.5 text-xs"
                        onClick={() => bump(def.defId, -1)}
                        data-testid={`deck-sel-remove-${def.defId}`}
                      >
                        −
                      </button>
                      <span className="w-5 text-center text-sm tabular-nums">{n}</span>
                      <button
                        type="button"
                        className="rounded bg-slate-700 px-2 py-0.5 text-xs disabled:opacity-40"
                        onClick={() => bump(def.defId, 1)}
                        disabled={plusDisabled(n)}
                        data-testid={`deck-sel-add-${def.defId}`}
                      >
                        ＋
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {/* 下：待选（完整卡池，点条目看详情浮层） */}
          <section className="flex min-h-0 flex-1 flex-col rounded border border-slate-800">
            <h2 className="flex items-center justify-between border-b border-slate-800 px-3 py-1.5 text-xs text-slate-300">
              <span>待选 · 共 {SORTED_POOL.length} 张</span>
              <span className="text-slate-500">点卡名看详情</span>
            </h2>
            <div className="min-h-0 flex-1 overflow-y-auto" data-testid="deck-pool">
              {SORTED_POOL.map((def) => {
                const n = deck.cards[def.defId] ?? 0;
                return (
                  <div
                    key={def.defId}
                    className="flex items-center gap-1.5 border-b border-slate-800/60 px-2 py-1.5 last:border-b-0"
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      onClick={() => setDetailId(def.defId)}
                      data-testid={`deck-row-${def.defId}`}
                    >
                      <span className={`min-w-0 truncate text-sm ${n > 0 ? 'text-cyan-100' : ''}`}>
                        {def.name}
                      </span>
                      <span className="shrink-0 text-[11px] text-slate-500">
                        {KIND_LABEL[def.type]} · 费{def.cost}
                        {def.type === 'minion' ? ` · 力${def.power}` : ''}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="rounded bg-slate-700 px-2 py-0.5 text-xs disabled:opacity-30"
                      onClick={() => bump(def.defId, -1)}
                      disabled={n === 0}
                      data-testid={`deck-remove-${def.defId}`}
                    >
                      −
                    </button>
                    <span className="w-5 text-center text-sm tabular-nums">{n}</span>
                    <button
                      type="button"
                      className="rounded bg-slate-700 px-2 py-0.5 text-xs disabled:opacity-30"
                      onClick={() => bump(def.defId, 1)}
                      disabled={plusDisabled(n)}
                      data-testid={`deck-add-${def.defId}`}
                    >
                      ＋
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      ) : (
        <p className="text-sm text-slate-400">还没有卡组，点「新建卡组」开始。</p>
      )}

      <p className="text-[11px] text-slate-500">
        卡组存在本机；满 {MAIN_DECK_SIZE} 张可在开局选用。一套卡组 = 30 张主卡 + 1 位指挥官，
        卡池不限体系，随便混着搭。
      </p>

      {/* 卡牌详情浮层 —— 手机贴底、桌面居中 */}
      {detailDef ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-3 sm:items-center"
          onClick={() => setDetailId(null)}
          data-testid="deck-detail"
        >
          <div
            className="flex w-full max-w-sm gap-3 rounded-lg border border-slate-700 bg-slate-900 p-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-24 shrink-0 sm:w-28">
              <CardTile
                name={detailDef.name}
                cost={detailDef.cost}
                power={detailDef.power}
                kind={detailDef.type}
                text={detailDef.text}
              />
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{detailDef.name}</p>
                  <p className="text-[11px] text-slate-400">
                    {KIND_LABEL[detailDef.type]} · 费{detailDef.cost} · 力{detailDef.power}
                  </p>
                </div>
                <button
                  type="button"
                  className="shrink-0 rounded border border-slate-700 px-2 py-0.5 text-xs"
                  onClick={() => setDetailId(null)}
                  data-testid="deck-detail-close"
                >
                  关闭
                </button>
              </div>
              <p className="mt-1.5 flex-1 text-xs leading-relaxed text-slate-300">
                {detailDef.text ?? '（无效果文本）'}
              </p>
              {detailDef.type === 'commander' ? (
                // 指挥官不在主卡组里，± 在这里没有意义 —— 给一句「去哪换」而不是留两个死按钮。
                <p className="mt-2 text-[11px] text-slate-400" data-testid="deck-detail-commander-note">
                  指挥官不占主卡组 —— 换人请点上方的其他指挥官。
                </p>
              ) : (
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  className="rounded bg-slate-700 px-3 py-1 text-sm disabled:opacity-30"
                  onClick={() => bump(detailDef.defId, -1)}
                  disabled={detailN === 0}
                  data-testid={`deck-detail-remove-${detailDef.defId}`}
                >
                  −
                </button>
                <span className="text-sm tabular-nums" data-testid="deck-detail-count">
                  {detailN} / {MAX_COPIES}
                </span>
                <button
                  type="button"
                  className="rounded bg-slate-700 px-3 py-1 text-sm disabled:opacity-30"
                  onClick={() => bump(detailDef.defId, 1)}
                  disabled={plusDisabled(detailN)}
                  data-testid={`deck-detail-add-${detailDef.defId}`}
                >
                  ＋
                </button>
              </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
