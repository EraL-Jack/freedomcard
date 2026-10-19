import { useState } from 'react';

import type { Faction, MatchFormat } from '@app/shared';

import type { RoomSession } from './useRoom.js';

/** 阵营选项 —— 与 shared 的 `Faction` 一一对应；空串 = 交给服务端按座位轮换。 */
const FACTIONS: readonly { value: Faction | ''; label: string }[] = [
  { value: '', label: '随机分配' },
  { value: 'blade', label: '炎刃 · 除外成长' },
  { value: 'frost', label: '霜律 · 冻结控制' },
  { value: 'star', label: '星轨 · 展示引擎' },
];

/**
 * 主界面 —— B1 补充 1：「主界面就是加入房间、创建房间、编辑卡组」。
 *
 * ⚠️ B1 明确说**不需要**大厅页、房间等待页、排行榜，故这里不建那些页面。
 * B1 补充 3：创建 / 加入房间即进入对战桌。
 *
 * D-132 / D-235：建房时选**赛制**（BO1/BO3）与**阵营**；加入时也选阵营。
 * docs/16 §1.3：先手胜率约 56.5%，座位差交给 BO3「双方各先手一次」消化。
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
  const [faction, setFaction] = useState<Faction | ''>('');
  const [joinFaction, setJoinFaction] = useState<Faction | ''>('');
  const [localError, setLocalError] = useState('');

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
            onChange={(e) => setNickname(e.target.value)}
            placeholder="玩家"
            data-testid="nickname"
          />
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

        {/* 阵营（D-235）：决定本方 30 张主卡组与指挥官 */}
        <label className="block">
          <span className="text-xs text-slate-400">我方阵营</span>
          <select
            className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2"
            value={faction}
            onChange={(e) => setFaction(e.target.value as Faction | '')}
            data-testid="faction"
          >
            {FACTIONS.map((f) => (
              <option key={f.value || 'random'} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="w-full rounded bg-emerald-700 px-4 py-3"
          onClick={() =>
            createOrJoin((name) => {
              // 服务端上限 8：超范围在这里折回，不要等服务器打回。
              const n = Math.min(8, Math.max(1, Math.round(Number(capacity) || 2)));
              session.create(name, n, format, faction || undefined);
            })
          }
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
        <label className="block">
          <span className="text-xs text-slate-400">我方阵营</span>
          <select
            className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2"
            value={joinFaction}
            onChange={(e) => setJoinFaction(e.target.value as Faction | '')}
            data-testid="join-faction"
          >
            {FACTIONS.map((f) => (
              <option key={f.value || 'random'} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="w-full rounded bg-sky-700 px-4 py-3 disabled:opacity-50"
          onClick={() => createOrJoin((name) => session.join(code, name, joinFaction || undefined))}
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
