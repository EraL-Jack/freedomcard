import { useState } from 'react';

import type { RoomSession } from './useRoom.js';

/**
 * 主界面 —— B1 补充 1：「主界面就是加入房间、创建房间、编辑卡组」。
 *
 * ⚠️ B1 明确说**不需要**大厅页、房间等待页、排行榜，故这里不建那些页面。
 * B1 补充 3：创建 / 加入房间即进入对战桌。
 */
export default function HomeScreen(props: {
  session: RoomSession;
  onEditDeck: () => void;
}): React.JSX.Element {
  const { session } = props;
  const [nickname, setNickname] = useState(() => localStorage.getItem('fc.nickname') ?? '');
  const [code, setCode] = useState('');
  const [capacity, setCapacity] = useState('2');

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
            onChange={(e) => setNickname(e.target.value)}
            placeholder="玩家"
            data-testid="nickname"
          />
        </label>

        <label className="block">
          <span className="text-xs text-slate-400">人数（建房用）</span>
          <input
            className="mt-1 w-20 rounded border border-slate-700 bg-slate-950 px-3 py-2"
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            inputMode="numeric"
            data-testid="capacity"
          />
        </label>

        <button
          type="button"
          className="w-full rounded bg-emerald-700 px-4 py-3"
          onClick={() => session.create(nickname, Number(capacity) || 2)}
          data-testid="create"
        >
          创建房间
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
          onClick={() => session.join(code, nickname)}
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
