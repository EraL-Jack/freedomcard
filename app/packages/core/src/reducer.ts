/**
 * 事件 → 状态的唯一演进入口。纯函数、不可变更新。
 *
 * 单独成文件（而不是留在 `engine.ts`）是为了打破循环依赖：
 * 规则处理器需要在内部「推演」自己产出的事件（如 `turn:end` 要连推多个阶段），
 * 若 `reduce` 在 `engine.ts` 里，规则模块就会反向依赖引擎。
 */

import type { CardInstance, GameEvent, GameState, PlayerId, Zone } from '@app/shared';

/** 取 payload 里的字符串，缺失返回空串。 */
function s(e: GameEvent, key: string): string {
  const v = e.payload?.[key];
  return typeof v === 'string' ? v : '';
}

/** 取 payload 里的数字，缺失返回 0。 */
function n(e: GameEvent, key: string): number {
  const v = e.payload?.[key];
  return typeof v === 'number' ? v : 0;
}

/** 取 payload 里的字符串数组。 */
function list(e: GameEvent, key: string): string[] {
  const v = e.payload?.[key];
  return Array.isArray(v) ? (v.filter((x) => typeof x === 'string') as string[]) : [];
}

/** 复制 player，避免污染入参。 */
function withPlayer(state: GameState, id: PlayerId, patch: (p: GameState['players'][string]) => void): GameState {
  const prev = state.players[id];
  if (!prev) return state;
  const next = { ...prev, zones: { ...prev.zones } };
  patch(next);
  return { ...state, players: { ...state.players, [id]: next } };
}

/**
 * 用一个事件演进状态。
 *
 * 约定：`card:moved` 的 `to` 区域一律**追加到末尾**。
 * 由于卡组顶 = `deck[0]`，追加到末尾即「置底」（起手换牌的「返回卡组底」依赖此语义）。
 */
export function reduce(state: GameState, event: GameEvent): GameState {
  switch (event.type) {
    case 'rng:advance':
      return { ...state, rngCursor: (state.rngCursor + Math.imul(n(event, 'steps'), 0x6d2b79f5)) >>> 0 };

    case 'deck:shuffled': {
      const id = s(event, 'playerId');
      const order = list(event, 'order');
      return withPlayer(state, id, (p) => {
        const byUid = new Map(p.zones.deck.map((c) => [c.uid, c]));
        const next: CardInstance[] = [];
        for (const uid of order) {
          const c = byUid.get(uid);
          if (c) {
            next.push(c);
            byUid.delete(uid);
          }
        }
        // 未在 order 中出现的卡（理论上不应有）保留在末尾，避免静默丢卡
        for (const c of byUid.values()) next.push(c);
        p.zones.deck = next;
      });
    }

    case 'card:moved': {
      const id = s(event, 'playerId');
      const uid = s(event, 'uid');
      const from = s(event, 'from') as Zone;
      const to = s(event, 'to') as Zone;
      return withPlayer(state, id, (p) => {
        const src = p.zones[from] ?? [];
        const card = src.find((c) => c.uid === uid);
        if (!card) return;
        p.zones[from] = src.filter((c) => c.uid !== uid);
        const dst = p.zones[to] ?? [];
        p.zones[to] = [...dst, card];
      });
    }

    case 'commander:revealed': {
      const id = s(event, 'playerId');
      const uid = s(event, 'uid');
      const defId = s(event, 'defId');
      return withPlayer(state, id, (p) => {
        if (p.zones.commander.some((c) => c.uid === uid)) return;
        p.zones.commander = [...p.zones.commander, { uid, defId }];
        p.commanderRevealed = true;
      });
    }

    /**
     * 指挥官力量值档位推进（X-7）。事件自带 `index` / `power`，
     * 状态里只存档位 —— 力量值本身始终由 `powerCurve` 推导，不落第二份数据。
     */
    case 'commander:grown':
      return withPlayer(state, s(event, 'playerId'), (p) => {
        p.commanderPowerIndex = n(event, 'index');
      });

    case 'mulligan:done':
      return withPlayer(state, s(event, 'playerId'), (p) => {
        p.mulliganDone = true;
      });

    case 'units:reset':
      return withPlayer(state, s(event, 'playerId'), (p) => {
        p.zones.board = p.zones.board.map((c) => ({ ...c, sleeping: false }));
      });

    case 'unit:asleep': {
      const id = s(event, 'playerId');
      const uid = s(event, 'uid');
      return withPlayer(state, id, (p) => {
        p.zones.board = p.zones.board.map((c) => (c.uid === uid ? { ...c, sleeping: true } : c));
      });
    }

    case 'health:changed':
      return withPlayer(state, s(event, 'playerId'), (p) => {
        p.health = n(event, 'value');
      });

    case 'maxCost:changed':
      return withPlayer(state, s(event, 'playerId'), (p) => {
        p.maxCost = n(event, 'value');
      });

    case 'phase:changed':
      return { ...state, phase: s(event, 'to') as GameState['phase'] };

    case 'turn:changed':
      return { ...state, turn: n(event, 'turn'), activeSeat: n(event, 'activeSeat') };

    case 'game:started': {
      const seats = list(event, 'seats');
      return { ...state, seats, activeSeat: 0, started: true };
    }

    // 战斗的**纯记录**事件（ADR-0013）：破坏由随后的 `card:moved` 承载，
    // 力量值快照写在 payload 里供回放与动画使用，本身不改状态。
    case 'attack:declared':
    case 'trigger:attack':
    case 'trigger:defend':
    case 'combat:resolved':
    case 'commander:damaged':
    case 'card:revealed':
      return state;

    case 'game:ended':
      return { ...state, winner: s(event, 'winner') || null };

    default:
      // 未知事件不改变状态 —— 但也不静默吞掉：交由上层核对事件白名单
      return state;
  }
}
