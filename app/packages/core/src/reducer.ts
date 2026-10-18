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

    /** 临时修正写入（ADR-0023 §3）：统领 3/7/9 档与军师触发器的载体。 */
    case 'unit:modified': {
      const id = s(event, 'playerId');
      const uid = s(event, 'uid');
      return withPlayer(state, id, (p) => {
        const patch = (c: CardInstance): CardInstance => {
          if (c.uid !== uid) return c;
          const next = { ...c };
          const tp = event.payload?.['tempPower'];
          if (typeof tp === 'number') next.tempPower = (next.tempPower ?? 0) + tp;
          const td = event.payload?.['tempDamage'];
          if (typeof td === 'number') next.tempDamage = (next.tempDamage ?? 0) + td;
          if (event.payload?.['attackRefresh'] === true) next.attackRefresh = true;
          return next;
        };
        p.zones.board = p.zones.board.map(patch);
        p.zones.commander = p.zones.commander.map(patch);
      });
    }

    /** 「每回合一次」记帐（ADR-0023 §3）。 */
    case 'effect:used':
      return withPlayer(state, s(event, 'playerId'), (p) => {
        const key = s(event, 'key');
        if (key && !p.effectsUsed.includes(key)) p.effectsUsed = [...p.effectsUsed, key];
      });

    /** 回合触发器登记（军师）。 */
    case 'trigger:added':
      return withPlayer(state, s(event, 'playerId'), (p) => {
        const t = event.payload?.['trigger'];
        if (t && typeof t === 'object') {
          p.turnTriggers = [...p.turnTriggers, t as unknown as (typeof p.turnTriggers)[number]];
        }
      });

    /** 触发器消耗一次（军师：炎刃随从登场 +1 已结算）。 */
    case 'trigger:spent':
      return withPlayer(state, s(event, 'playerId'), (p) => {
        const sourceUid = s(event, 'sourceUid');
        p.turnTriggers = p.turnTriggers
          .map((t) => (t.sourceUid === sourceUid ? { ...t, remaining: t.remaining - 1 } : t))
          .filter((t) => t.remaining > 0);
      });

    /** 待定选择挂起 / 清除（ADR-0023 §2）—— 选择是状态的一部分，必须走事件。 */
    case 'choice:pending': {
      const choice = event.payload?.['choice'];
      if (!choice || typeof choice !== 'object') return state;
      return { ...state, pendingChoice: choice as unknown as GameState['pendingChoice'] };
    }
    case 'choice:cleared':
      return { ...state, pendingChoice: null };

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

    case 'phase:changed': {
      const to = s(event, 'to') as GameState['phase'];
      // 进入抽牌阶段 → 重置「已抽」标记（Era 2026-10-18：抽牌改为手动点击卡组）。
      let next: GameState = { ...state, phase: to, ...(to === 'draw' ? { drawnThisPhase: false } : {}) };
      // 「每回合一次」在自己回合重置（Era 2026-10-18 口径，ADR-0023 §3）：
      // 进入**己方充能阶段**时清空记帐 —— 与指挥官成长同一接线点。
      if (to === 'charge') {
        const active = next.seats[next.activeSeat];
        if (active) {
          next = withPlayer(next, active, (p) => {
            p.effectsUsed = [];
          });
        }
      }
      return next;
    }

    /** 手动抽牌完成（`draw.ts`）—— 标记本阶段已抽，允许推进到下一阶段。 */
    case 'draw:completed':
      return { ...state, drawnThisPhase: true };

    case 'turn:changed': {
      // 回合切换 = 「本回合」词缀的边界（ADR-0023 §3）：
      // 清空全场卡的临时修正与双方触发器。
      const players: GameState['players'] = {};
      for (const [id, p] of Object.entries(state.players)) {
        players[id] = {
          ...p,
          turnTriggers: [],
          zones: {
            ...p.zones,
            board: p.zones.board.map((c) => {
              const { tempPower: _tp, tempDamage: _td, attackRefresh: _ar, ...rest } = c;
              return rest;
            }),
            commander: p.zones.commander.map((c) => {
              const { tempPower: _tp, tempDamage: _td, attackRefresh: _ar, ...rest } = c;
              return rest;
            }),
          },
        };
      }
      return { ...state, players, turn: n(event, 'turn'), activeSeat: n(event, 'activeSeat') };
    }

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
