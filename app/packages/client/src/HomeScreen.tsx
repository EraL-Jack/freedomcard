import { useState } from 'react';

import { MAIN_DECK_SIZE } from '@app/shared/constants';
import type { MatchFormat } from '@app/shared/types';
import { CARD_POOL } from '@app/shared/cards';
import { TURN_TIMEOUT_MS, TURN_TIMEOUT_OPTIONS } from '@app/shared/constants';

import {
  listSelectionOptions,
  loadActiveDeckId,
  saveActiveDeckId,
  selectionForPlay,
} from './decks.js';
import { turnTimeoutLabel } from './labels.js';
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
}): React.JSX.Element {  const { session } = props;
  const [nickname, setNickname] = useState(() => localStorage.getItem('fc.nickname') ?? '');
  const [code, setCode] = useState('');
  const [format, setFormat] = useState<MatchFormat>('bo1');
  /** 回合时限（H18）：30 / 60 / 180 / 999 秒，默认 60s。 */
  const [turnMs, setTurnMs] = useState(String(TURN_TIMEOUT_MS));
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

  /**
   * 服务端连接态（D-255）。
   *
   * 断线时 socket.io 的 `emit` 会静默排队，按钮点下去一点反馈都没有 ——
   * Era 2026-10-21 报的「点击人机对战没反应」就是这一类。
   * 后果是玩家只会反复点。所以断线时**把按钮本身置灰**，并写清原因。
   */
  const online = session.link === 'online';

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
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-3 p-4">
      {/*
        系统提示条（D-256）—— 这是「点了没反应」的根治。

        Era 2026-10-21 第二次报「创建房间、人机对战都没反应」。查下来不是业务坏了，
        而是**这两句提示原本渲染在页面最底部**：390×844 的手机上它落在 top≈900，
        屏幕外 56px。服务端其实回了错误，玩家一个字都看不见。

        两个设计决定：
        ① **粘在视口顶部**（`sticky top-0`）而不是跟着某个按钮走 ——
           建房按钮在上半屏、加入按钮在下半屏，玩家滚到哪儿都得能看见它；
        ② **只在有话说的时候出现**，正常状态不占位、不制造噪音。
      */}
      {localError || session.notice ? (
        <div className="sticky top-0 z-20 -mx-4 -mt-4 space-y-2 bg-[#020617] px-4 pb-2 pt-4">
          {localError ? (
            <p
              className="rounded border border-rose-700 bg-rose-950/60 px-3 py-2 text-sm text-rose-200"
              role="alert"
              data-testid="local-error"
            >
              {localError}
            </p>
          ) : null}
          {session.notice ? (
            <p
              className="rounded border border-amber-700/60 bg-amber-950/40 px-3 py-2 text-sm text-amber-200"
              role="status"
              data-testid="notice"
            >
              {session.notice}
            </p>
          ) : null}
        </div>
      ) : null}

      {/*
        标题行（issue #116 / D-296）—— 「编辑卡组」原本是整页最后一个按钮，
        1366×768 下落在 top 834、完全在首屏之外（需滚 164px）。第一次进来的玩家
        因此以为只有三套预设卡组能用 —— 而卡组编辑正是这个 Demo 的卖点。

        挪到标题右侧后，它的位置不再取决于下面表单有多长：表单以后再加一行也不会把它挤出去。
        按钮保留 `data-testid="edit-deck"`（E2E 与卡组链路都靠它）。
      */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">ETCG</h1>
          {/* A1（P-08）：Era 2026-10-21 —— 「暂时代称可以叫 ETCG，风格为混合风格，什么样的卡组都会有」。
              游戏名仍是他起的名，副标题把这句风格原话直接摆出来，不另行发挥。 */}
          <p className="mt-0.5 text-xs text-slate-400">混合风格 · 什么样的卡组都有</p>
        </div>
        <button
          type="button"
          className="shrink-0 rounded border border-slate-700 px-3 py-2 text-sm"
          onClick={props.onEditDeck}
          data-testid="edit-deck"
        >
          编辑卡组
        </button>
      </div>

      {/*
        连接状态 + 房间状态并成一行（issue #116）：两句话各占一行时纯属浪费首屏高度。
        「当前不在房间内」这句文案保留 —— 进过房间再回来的人需要它来确认自己真的出来了。
      */}
      <p className="text-xs text-slate-400">
        {session.link === 'online' ? (
          <span className="text-emerald-400">服务端已连接</span>
        ) : session.link === 'connecting' ? (
          <span className="text-amber-400">服务端连接中…</span>
        ) : (
          <span className="text-rose-400">服务端未连接</span>
        )}
        <span className="ml-2 text-slate-500">当前不在房间内。</span>
      </p>

      {!online ? (
        <p className="text-xs text-amber-300" data-testid="offline-hint">
          服务端{session.link === 'connecting' ? '连接中' : '未连接'}，建房与加入暂不可用（会自动重连）
        </p>
      ) : null}

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

        {/* 赛制（D-132）+ 回合时限（H18）—— 并成一行（issue #116）：两者都是「开这局之前
            顺手选一下」的短选项，各占一整行会把「加入房间」整段推出首屏。 */}
        <div className="grid grid-cols-2 gap-2">
          {/* 赛制：BO1 一局定胜负；BO3 三局两胜、双方各先手一次 */}
          <label className="block">
            <span className="text-xs text-slate-400">赛制</span>
            <select
              className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-2"
              value={format}
              onChange={(e) => setFormat(e.target.value === 'bo3' ? 'bo3' : 'bo1')}
              data-testid="format"
            >
              <option value="bo1">BO1 · 一局定胜负</option>
              <option value="bo3">BO3 · 三局两胜</option>
            </select>
          </label>
          {/*
            回合时限（H18）—— Era 2026-10-21：「时长建议在建房能选择，30-60-180-999」。
            档位写死在 shared（`TURN_TIMEOUT_OPTIONS`），客户端只负责选择与展示；
            服务端仍按白名单归一，非法值回落默认，老客户端不带该字段也能建房。
          */}
          <label className="block">
            <span className="text-xs text-slate-400">每回合时限</span>
            <select
              className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-2"
              value={turnMs}
              onChange={(e) => setTurnMs(e.target.value)}
              data-testid="turn-timeout"
            >
              {TURN_TIMEOUT_OPTIONS.map((ms) => (
                <option key={ms} value={String(ms)}>
                  {turnTimeoutLabel(ms)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <button
          type="button"
          className="w-full rounded bg-emerald-700 px-4 py-3 disabled:opacity-50"
          disabled={!online || session.busy !== null}
          onClick={() =>
            createOrJoin((name) => {
              const play = selectionForPlay();
              // 人数固定 2（T-07）：规则只验证过 2 人，界面不再给出 3~8 的入口。
              session.create({
                nickname: name,
                capacity: 2,
                format,
                deck: play.deck,
                commander: play.commander,
                turnTimeoutMs: Number(turnMs),
              });
            })
          }
          data-testid="create"
        >
          {session.busy === 'create' ? '正在建房…' : '创建房间'}
        </button>

        {/*
          人机对战（D-242，Era 2026-10-21）—— 开房即坐入一个 AI 席位，
          不用再开两个窗口自己跟自己打。用的仍是上面选的**卡组 / 赛制 / 时限**，
          所以人机房也能拿来试新卡组。
        */}
        <button
          type="button"
          className="w-full rounded border border-emerald-700 bg-emerald-900/40 px-4 py-3 text-emerald-100 disabled:opacity-50"
          disabled={!online || session.busy !== null}
          onClick={() =>
            createOrJoin((name) => {
              const play = selectionForPlay();
              session.create({
                nickname: name,
                capacity: 2,
                format,
                deck: play.deck,
                commander: play.commander,
                solo: true,
                turnTimeoutMs: Number(turnMs),
              });
            })
          }
          data-testid="create-solo"
        >
          {session.busy === 'create-solo' ? '正在开人机房…' : '人机对战（对手：电脑）'}
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
          disabled={!code.trim() || !online || session.busy !== null}
          data-testid="join"
        >
          {session.busy === 'join' ? '正在加入…' : '加入房间'}
        </button>
      </section>

      {/* 「编辑卡组」已移到标题行（issue #116）—— 这里不再放第二个入口，
          两个同名按钮只会让「我刚才点的是哪个」变成问题。 */}

      <p className="mt-auto text-[11px] text-slate-500">
        视觉为占位风格（纯色 + 文字卡），等待 B6 / B7 的美术输入。
      </p>
    </main>
  );
}
