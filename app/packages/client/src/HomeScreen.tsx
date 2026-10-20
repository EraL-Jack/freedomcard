import { useState } from 'react';

import { MAIN_DECK_SIZE, type MatchFormat } from '@app/shared';
import { CARD_POOL } from '@app/shared/cards';

import {
  listSelectionOptions,
  loadActiveDeckId,
  saveActiveDeckId,
  selectionForPlay,
} from './decks.js';
import type { RoomSession } from './useRoom.js';

/**
 * 主界面 —— B1 补充 1：「主界面就是加入房间、创建房间、编辑卡组」。
 *
 * ⚠️ B1 明确说**不需要**大厅页、房间等待页、排行榜，故这里不建那些页面。
 * B1 补充 3：创建 / 加入房间即进入对战桌。
 *
 * D-132：建房时选**赛制**（BO1/BO3）。
 *
 * ## D-184 / ADR-0042：阵营下拉已删除
 *
 * Era：「我的设计里不存在阵营之分，卡池可以混选……根据卡组选择就行了。」
 * 于是这里只剩「用哪套卡组」——一套卡组自带 30 张主卡与 1 位指挥官，
 * 建房与加入用的是同一个选择（准备页还能改）。
 */
export default function HomeScreen(props: {
  session: RoomSession;
  onEditDeck: () => void;
}): React.JSX.Element {
  const { session } = props;
  const [nickname, setNickname] = useState(() => localStorage.getItem('fc.nickname') ?? '');
  const [code, setCode] = useState('');
  const [capacity, setCapacity] = useState('2');
  const [format, setFormat] = useState<MatchFormat>('bo1');
  const [localError, setLocalError] = useState('');

  /**
   * 卡组选择（D-141 / D-184）：对局前在这里选，准备页还能改。
   *
   * 选项 = 三套基础卡组（恒可开局）+ 我的卡组（不足 30 张的置灰并显示张数）。
   * 选择落 localStorage，与准备页共用同一个「当前卡组」。
   *
   * ⚠️ 默认值不能留空：没有「阵营默认」这回事了，界面必须明确指向一套，
   * 否则玩家看到的和实际开局的可能不是同一套。
   */
  const [options] = useState(listSelectionOptions);
  /**
   * 初始值优先用**本机记住的那一套**（哪怕它已经被改到不满 30 张 —— 那正是要提示的情况）。
   * 只有记住的 id 已经不存在时，才退到第一套可用的。
   *
   * ⚠️ 不能直接用 `selectionForPlay().value`：那会**静默换掉**玩家的选择，
   * 于是「这套不满 30 张」的提示永远不会出现，玩家以为用的就是它。
   */
  const [deckValue, setDeckValue] = useState(() => {
    const saved = loadActiveDeckId();
    if (options.some((o) => o.value === saved)) return saved;
    return options.find((o) => o.complete)?.value ?? options[0]?.value ?? '';
  });
  /** 下拉里选中的那条（可能不满 30 张 —— 那只是「想用」）。 */
  const chosen = options.find((o) => o.value === deckValue) ?? selectionForPlay();
  /** 真正会提交的那一套 —— 选中的不可用时回落第一套基础卡组。 */
  const play = chosen.complete ? chosen : selectionForPlay();
  const playCommanderName = CARD_POOL[play.commander]?.name ?? play.commander;

  const pickDeck = (value: string): void => {
    setDeckValue(value);
    saveActiveDeckId(value);
  };

  /** 建房 / 加房前的**本地**校验 —— 不发请求就能拦住的错误，不要等服务器打回。 */
  const createOrJoin = (action: (name: string) => void): void => {
    const name = nickname.trim();
    if (!name) {
      setLocalError('请先填写昵称');
      return;
    }
    if (name.length > 24) {
      setLocalError('昵称最多 24 个字');
      return;
    }
    setLocalError('');
    action(name);
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 p-4">
      <h1 className="text-xl font-semibold">卡牌对战 Demo</h1>

      <p className="text-xs text-slate-400">
        {session.link === 'online' ? (
          <span className="text-emerald-400">服务端已连接</span>
        ) : session.link === 'connecting' ? (
          <span className="text-amber-400">服务端连接中…</span>
        ) : (
          <span className="text-rose-400">服务端未连接</span>
        )}
      </p>

      <p className="text-xs text-slate-500">当前不在房间内。</p>

      <section className="space-y-3 rounded-lg border border-slate-800 bg-slate-900 p-4">
        <label className="block">
          <span className="text-xs text-slate-400">昵称</span>
          <input
            className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2"
            value={nickname}
            /* 边输边存（D-158）：原来只在建房/加入时才落盘，于是「输昵称 → 去编辑卡组 → 返回」
               昵称就没了。HomeScreen 每次挂载都从 localStorage 初始化，存晚了等于没存。 */
            onChange={(e) => {
              setNickname(e.target.value);
              localStorage.setItem('fc.nickname', e.target.value);
            }}
            placeholder="玩家"
            data-testid="nickname"
          />
        </label>

        {/* 卡组（D-141 / D-184）：建房与加入都用这里的选择；准备页还能改 */}
        <label className="block">
          <span className="text-xs text-slate-400">我的卡组（卡组自带指挥官）</span>
          <select
            className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2"
            value={deckValue}
            onChange={(e) => pickDeck(e.target.value)}
            data-testid="deck-choice"
          >
            {options.map((o) => {
              const n = o.deck.length;
              const suffix = o.complete ? '' : `，未完成`;
              return (
                <option key={o.value} value={o.value} disabled={!o.complete}>
                  {o.label}（{n}/{MAIN_DECK_SIZE} 张{suffix}）· {CARD_POOL[o.commander]?.name ?? ''}
                </option>
              );
            })}
          </select>
          <p className="mt-1 text-[11px] text-slate-500" data-testid="deck-in-use">
            本局使用：{play.label} · 指挥官 {playCommanderName}
          </p>
          {/*
            选了一套但不完整 —— 现在会**回落**到第一套基础卡组（不再有「阵营默认」）。
            不提示等于骗玩家「我用的就是这套」。
          */}
          {!chosen.complete ? (
            <p className="mt-1 text-[11px] text-amber-300" data-testid="deck-incomplete-hint">
              所选卡组不足 {MAIN_DECK_SIZE} 张，开局将使用「{play.label}」
            </p>
          ) : null}
        </label>

        <label className="block">
          <span className="text-xs text-slate-400">人数（建房用，1–8）</span>
          <input
            className="mt-1 w-20 rounded border border-slate-700 bg-slate-950 px-3 py-2"
            value={capacity}
            onChange={(e) => setCapacity(e.target.value.replace(/\D/g, ''))}
            inputMode="numeric"
            min={1}
            max={8}
            data-testid="capacity"
          />
        </label>

        {/* 赛制（D-132）：BO1 一局定胜负；BO3 三局两胜、双方各先手一次 */}
        <label className="block">
          <span className="text-xs text-slate-400">赛制</span>
          <select
            className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2"
            value={format}
            onChange={(e) => setFormat(e.target.value === 'bo3' ? 'bo3' : 'bo1')}
            data-testid="format"
          >
            <option value="bo1">BO1 · 一局定胜负</option>
            <option value="bo3">BO3 · 三局两胜（各先手一次）</option>
          </select>
        </label>

        <button
          type="button"
          className="w-full rounded bg-emerald-700 px-4 py-3"
          onClick={() =>
            createOrJoin((name) => {
              // 服务端上限 8：超范围在这里折回，不要等服务器打回。
              const n = Math.min(8, Math.max(1, Math.round(Number(capacity) || 2)));
              const play = selectionForPlay();
              session.create(name, n, format, play.deck, play.commander);
            })
          }
          data-testid="create"
        >
          创建房间
        </button>

        {/*
          人机对战（D-242，Era 2026-10-21）—— 开房即坐入一个 AI 席位，
          不用再开两个窗口自己跟自己打。用的仍是上面选的**卡组 / 赛制**，
          所以人机房也能拿来试新卡组。
        */}
        <button
          type="button"
          className="w-full rounded border border-emerald-700 bg-emerald-900/40 px-4 py-3 text-emerald-100"
          onClick={() =>
            createOrJoin((name) => {
              const play = selectionForPlay();
              session.create(name, 2, format, play.deck, play.commander, true);
            })
          }
          data-testid="create-solo"
        >
          人机对战（对手：电脑）
        </button>
      </section>

      <section className="space-y-3 rounded-lg border border-slate-800 bg-slate-900 p-4">
        <label className="block">
          <span className="text-xs text-slate-400">房间码</span>
          <input
            className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 uppercase tracking-widest"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABC123"
            data-testid="code"
          />
        </label>
        <button
          type="button"
          className="w-full rounded bg-sky-700 px-4 py-3 disabled:opacity-50"
          onClick={() =>
            createOrJoin((name) => {
              // 加入时也用同一套卡组选择（D-184：不再有单独的「加入阵营」下拉）。
              const play = selectionForPlay();
              session.join(code, name, play.deck, play.commander);
            })
          }
          disabled={!code.trim()}
          data-testid="join"
        >
          加入房间
        </button>
      </section>

      <button
        type="button"
        className="rounded border border-slate-700 px-4 py-3"
        onClick={props.onEditDeck}
        data-testid="edit-deck"
      >
        编辑卡组
      </button>

      {localError ? (
        <p className="text-sm text-rose-300" data-testid="local-error">
          {localError}
        </p>
      ) : null}

      {session.notice ? (
        <p className="text-sm text-amber-300" data-testid="notice">
          {session.notice}
        </p>
      ) : null}

      <p className="mt-auto text-[11px] text-slate-500">
        视觉为占位风格（纯色 + 文字卡），等待 B6 / B7 的美术输入。
      </p>
    </main>
  );
}
