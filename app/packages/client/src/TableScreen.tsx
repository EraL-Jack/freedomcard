import { useEffect, useState } from 'react';

import * as core from '@app/core';
import type { CardInstance, GameState, PlayerState, Zone } from '@app/shared';

import { CARD_POOL } from '@app/shared/cards';

import CardTile from './CardTile.js';
import { PHASE_LABEL } from './labels.js';
import type { RoomSession } from './useRoom.js';

/**
 * 对战桌 —— B2 布局（我方视角，自上而下六排）+ B2-5 右侧日志列。
 *
 * ⚠️ **状态只从服务端来**：本组件不计算「这张牌能不能出」，只把选中项交给
 * `session.play(...)`，由服务端校验并广播结果（ADR-0002）。
 * 置灰只是「现在轮不到你」，不是本地裁决。
 *
 * ⚠️ B2 第 4 排与第 5 排都出现了「我方费用区」—— 原文如此，
 * `docs/01` §1.3 #3 记为待 Era 确认，此处照抄不擅自合并。
 */

/**
 * 把一张卡实例渲染成占位卡（卡名 / 数值都要去卡池查定义）。
 *
 * ⚠️ 力量值取**当前值**而非卡面定义值（ADR-0016 §8）：指挥官按 X-7 的曲线
 * 在每次己方充能阶段成长，取 `def.power` 会让它**永远显示第 0 档** ——
 * 曲线实现了，但玩家看不见，等于白做。
 */
function CardOf(props: {
  card: CardInstance;
  state: GameState;
  sleeping?: boolean;
  selected?: boolean;
  onClick?: () => void;
}): React.JSX.Element {
  const def = CARD_POOL[props.card.defId];
  const power = core.unitPower(props.state, CARD_POOL, props.card.uid) ?? def?.power ?? 0;
  return (
    <div className="w-16 shrink-0 sm:w-20">
      <CardTile
        name={def?.name ?? props.card.defId}
        cost={def?.cost ?? 0}
        power={power}
        kind={def?.type ?? 'minion'}
        text={def?.text}
        sleeping={props.sleeping}
        selected={props.selected}
        onSelect={props.onClick}
      />
    </div>
  );
}

/**
 * 区域块 —— B2-3：弃牌 / 除外 / 费用区默认**缩略**（只显示数量），点击展开全貌。
 * 费用区按 B2-3 的要求**直接显示数量**。
 *
 * `onCardClick` 是为了让**指挥官区也能当攻击目标**（ADR-0022）——
 * 此前只有随从区可点，导致「打指挥官 → 扣血 → 血空结束」这条已确认的规则
 * 在界面上走不到，只能互砍随从、永远分不出胜负。
 */
function ZoneBox(props: {
  label: string;
  zone: Zone;
  cards: readonly CardInstance[];
  state: GameState;
  expandable?: boolean;
  /** 点击区域内某张卡的回调 —— 不传则该区域不可点（默认）。 */
  onCardClick?: (uid: string) => void;
  selected?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const shown = props.expandable && !open ? [] : props.cards;

  return (
    // testid 挂在**容器**上而非按钮：这样断言能看到展开的卡片内容，
    // 断言的是「这个区域有什么」而不是「这个按钮写了什么」。
    <div className="rounded border border-slate-700 bg-slate-900/60 p-1" data-testid={`zone-${props.zone}`}>
      <button
        type="button"
        className="flex w-full items-center justify-between gap-1 text-[10px] text-slate-400"
        onClick={() => setOpen((v) => !v)}
        disabled={!props.expandable}
      >
        <span className="truncate">{props.label}</span>
        <span className="shrink-0 text-slate-200">{props.cards.length}</span>
      </button>
      {shown.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-0.5">
          {shown.map((c) => (
            <CardOf
              key={c.uid}
              card={c}
              state={props.state}
              selected={props.selected}
              onClick={props.onCardClick ? () => props.onCardClick?.(c.uid) : undefined}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 随从区的一个位置（B2 布局里的「随从区 1·2·3」，上限 3）。 */
function BoardSlot(props: {
  index: number;
  card?: CardInstance;
  state: GameState;
  selected?: boolean;
  onClick?: () => void;
}): React.JSX.Element {
  return (
    <div
      className="flex min-h-[44px] flex-col items-center justify-center rounded border border-dashed border-slate-700 bg-slate-900/40 p-1"
      data-testid={`slot-${props.index}`}
    >
      {props.card ? (
        <CardOf
          card={props.card}
          state={props.state}
          sleeping={props.card.sleeping}
          selected={props.selected}
          onClick={props.onClick}
        />
      ) : (
        <span className="text-[10px] text-slate-600">{props.index + 1}</span>
      )}
    </div>
  );
}

/** 未开局时的等待界面 —— B1 补充 3：双方加入并准备后即开始游戏。 */
function WaitingRoom({ session }: { session: RoomSession }): React.JSX.Element {
  const { room, me, ready, notice, leave } = session;
  const meReady = room?.seats.find((s) => s && s.playerId === me)?.ready ?? false;

  return (
    <div className="flex flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-lg">房间码</p>
      <p className="font-mono text-3xl tracking-widest text-emerald-300" data-testid="room-code">
        {room?.code ?? '—'}
      </p>
      <p className="text-xs text-slate-400">
        {room?.seats.filter(Boolean).length ?? 0}/{room?.capacity ?? 0} 人 · {room?.phase}
      </p>
      <ul className="space-y-1 text-sm" data-testid="seats">
        {room?.seats.map((s, i) => (
          <li key={i} className={s ? 'text-slate-200' : 'text-slate-500'}>
            {i + 1} 号位：
            {s ? (
              <>
                {s.nickname}
                {s.playerId === me ? '（你）' : ''} · {s.ready ? '已准备' : '未准备'}
              </>
            ) : (
              '空'
            )}
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="rounded bg-emerald-700 px-6 py-3 text-base disabled:opacity-50"
        onClick={ready}
        disabled={meReady}
        data-testid="ready"
      >
        {meReady ? '已准备，等待对手…' : '准备'}
      </button>

      <button
        type="button"
        className="rounded border border-slate-700 px-4 py-2 text-sm"
        onClick={leave}
        data-testid="leave"
      >
        离开房间
      </button>

      {notice ? (
        <p className="text-xs text-amber-300" data-testid="notice">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

export default function TableScreen({ session }: { session: RoomSession }): React.JSX.Element {
  const { room, state, me, foe, turnDeadline, log, notice } = session;
  const [picked, setPicked] = useState<string[]>([]);
  const [attacker, setAttacker] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // 每秒刷新一次，用于显示回合倒计时。
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!me || !room) {
    return <p className="p-4 text-slate-400">请从主界面创建或加入房间。</p>;
  }
  if (!state || !state.started) {
    return <WaitingRoom session={session} />;
  }

  const mine: PlayerState | undefined = me ? state.players[me] : undefined;
  const theirs: PlayerState | undefined = foe ? state.players[foe] : undefined;
  if (!mine || !theirs) {
    return <p className="p-4 text-slate-400">等待对手加入…</p>;
  }

  const myTurn = state.seats[state.activeSeat] === me;
  // ⚠️ 客户端时钟与服务端未必同步，这里的倒计时是**示意**；权威判定在服务端（ADR-0017）。
  const remain = turnDeadline ? Math.max(0, Math.ceil((turnDeadline - now) / 1000)) : null;

  const togglePick = (uid: string): void => {
    setPicked((prev) => (prev.includes(uid) ? prev.filter((x) => x !== uid) : [...prev, uid]));
  };

  const slots = [0, 1, 2];

  return (
    <div className="flex h-dvh flex-col gap-1 p-1 sm:p-2">
      {/* 回合数 / 计时居中（B2-5） */}
      <header className="flex items-center justify-center gap-3 text-xs sm:text-sm">
        <span data-testid="turn">第 {state.turn} 回合</span>
        <span className="text-slate-400">阶段 {PHASE_LABEL[state.phase]}</span>
        <span className="text-slate-400">计时 {remain === null ? '—' : `${remain}s`}</span>
        {/*
          血量 —— B2 布局原文**未覆盖**，但 A3 的胜负条件就是「血空判负」：
          不显示血量，玩家既看不到战况，也不知道自己快输了，
          等于把已接通的判负链路（ADR-0014）对玩家隐藏起来。
          故按最小改动补在 B2-5 的信息条里，位置待 Era 确认。
        */}
        <span className="text-rose-300" data-testid="hp-foe">
          对手 {theirs.health}
        </span>
        <span className="text-emerald-300" data-testid="hp-me">
          我方 {mine.health}
        </span>
        <span className={myTurn ? 'text-emerald-400' : 'text-slate-500'}>
          {myTurn ? '你的回合' : '对手回合'}
        </span>
      </header>

      <div className="flex min-h-0 flex-1 gap-1">
        {/* 对战桌主体 */}
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          {/* ① 对方手牌 —— 只显示张数，不暴露内容 */}
          <section className="rounded border border-slate-700 bg-slate-900/40 px-2 py-1 text-[11px] text-slate-400">
            对方手牌 {theirs.zones.hand.length} 张
          </section>

          {/* ② 对方五区 */}
          <section className="grid grid-cols-5 gap-1">
            <ZoneBox label="卡组区" zone="deck" cards={theirs.zones.deck} expandable state={state} />
            <ZoneBox label="法术区" zone="spell" cards={theirs.zones.spell} expandable state={state} />
            {/* ADR-0022：指挥官也是合法攻击目标 —— 否则只能互砍随从，永远分不出胜负。
                嘲讽优先由引擎裁决（A7），界面不预判，被拒就显示服务端原因。 */}
            <ZoneBox
              label="指挥官"
              zone="commander"
              cards={theirs.zones.commander}
              state={state}
              selected={attacker !== null}
              onCardClick={
                attacker && myTurn
                  ? (uid) => {
                      session.attack(attacker, uid);
                      setAttacker(null);
                    }
                  : undefined
              }
            />
            <ZoneBox label="弃牌区" zone="graveyard" cards={theirs.zones.graveyard} expandable state={state} />
            <ZoneBox label="除外区" zone="exile" cards={theirs.zones.exile} expandable state={state} />
          </section>

          {/* ③ 对方费用区 + 随从区 1·2·3 */}
          <section className="grid grid-cols-4 gap-1">
            <ZoneBox label="费用区" zone="cost" cards={theirs.zones.cost} expandable state={state} />
            {slots.map((i) => (
              <BoardSlot
                key={i}
                index={i}
                state={state}
                card={theirs.zones.board[i]}
                selected={attacker !== null && false}
                onClick={
                  attacker && myTurn
                    ? () => {
                        const uid = theirs.zones.board[i]?.uid;
                        if (uid) session.attack(attacker, uid);
                        setAttacker(null);
                      }
                    : undefined
                }
              />
            ))}
          </section>

          {/* ④ 我方随从区 1·2·3 + 费用区 */}
          <section className="grid grid-cols-4 gap-1">
            {slots.map((i) => (
              <BoardSlot
                key={i}
                index={i}
                state={state}
                card={mine.zones.board[i]}
                selected={attacker === mine.zones.board[i]?.uid}
                onClick={() => {
                  const uid = mine.zones.board[i]?.uid;
                  setAttacker((prev) => (prev === uid ? null : (uid ?? null)));
                }}
              />
            ))}
            <ZoneBox label="费用区" zone="cost" cards={mine.zones.cost} expandable state={state} />
          </section>

          {/* ⑤ 我方五区 —— 第 2 项「费用区」与第 ④ 排重复，原文如此，待 Era 确认 */}
          <section className="grid grid-cols-5 gap-1">
            <ZoneBox label="除外区" zone="exile" cards={mine.zones.exile} expandable state={state} />
            <ZoneBox label="费用区" zone="cost" cards={mine.zones.cost} expandable state={state} />
            <ZoneBox label="指挥官" zone="commander" cards={mine.zones.commander} state={state} />
            <ZoneBox label="法术区" zone="spell" cards={mine.zones.spell} expandable state={state} />
            <ZoneBox label="卡组区" zone="deck" cards={mine.zones.deck} expandable state={state} />
          </section>

          {/* ⑥ 我方手牌 —— 可横向滚动（B2-2） */}
          <section className="overflow-x-auto rounded border border-slate-700 bg-slate-900/40 p-1">
            <div className="flex gap-1" data-testid="hand">
              {mine.zones.hand.map((c) => (
                <CardOf
                  key={c.uid}
                  card={c}
                  state={state}
                  selected={picked.includes(c.uid)}
                  onClick={() => togglePick(c.uid)}
                />
              ))}
              {mine.zones.hand.length === 0 ? (
                <span className="px-2 text-[11px] text-slate-500">手牌为空</span>
              ) : null}
            </div>
          </section>
        </div>

        {/* 右侧一列：日志框 + 对话框分开展示（B2-5） */}
        <aside className="hidden w-40 shrink-0 flex-col gap-1 sm:flex md:w-56">
          <div
            className="min-h-0 flex-1 overflow-y-auto rounded border border-slate-700 bg-slate-900/60 p-1 text-[11px]"
            data-testid="log"
          >
            {log.map((l) => (
              <p key={l.id} className="text-slate-300">
                {l.text}
              </p>
            ))}
          </div>
          <div className="h-20 rounded border border-slate-700 bg-slate-900/60 p-1 text-[11px] text-slate-500">
            对话框（占位）
          </div>
        </aside>
      </div>

      {/* 操作条 —— 只发 Intent，不做本地裁决 */}
      <footer className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          className="rounded bg-slate-700 px-3 py-2 text-xs disabled:opacity-40 sm:text-sm"
          onClick={session.advance}
          disabled={!myTurn}
          data-testid="advance"
        >
          推进阶段
        </button>
        <button
          type="button"
          className="rounded bg-slate-700 px-3 py-2 text-xs disabled:opacity-40 sm:text-sm"
          onClick={session.endTurn}
          disabled={!myTurn}
          data-testid="end-turn"
        >
          结束回合
        </button>
        <button
          type="button"
          className="rounded bg-cyan-800 px-3 py-2 text-xs disabled:opacity-40 sm:text-sm"
          onClick={() => {
            for (const uid of picked) session.play(uid);
            setPicked([]);
          }}
          disabled={!myTurn || picked.length === 0}
          data-testid="play"
        >
          出牌
        </button>
        <button
          type="button"
          className="rounded bg-amber-800 px-3 py-2 text-xs disabled:opacity-40 sm:text-sm"
          onClick={() => {
            session.charge(picked);
            setPicked([]);
          }}
          disabled={!myTurn || picked.length === 0}
          data-testid="charge"
        >
          充能
        </button>
        <button
          type="button"
          className="rounded bg-rose-800 px-3 py-2 text-xs disabled:opacity-40 sm:text-sm"
          onClick={() => setAttacker(null)}
          disabled={attacker === null}
          data-testid="cancel-attack"
        >
          取消攻击
        </button>
        <button
          type="button"
          className="rounded bg-slate-800 px-3 py-2 text-xs sm:text-sm"
          onClick={session.leave}
          data-testid="leave"
        >
          离开
        </button>
        {notice ? (
          <span className="text-xs text-amber-300" data-testid="notice">
            {notice}
          </span>
        ) : null}
      </footer>
    </div>
  );
}
