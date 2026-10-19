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
        // 霜冻是**实例状态位**（ADR-0025）：离开随从区即消失，回场时必须是干净实例。
        let movedCard = card;
        if (from === 'board' && card.frozen) {
          const { frozen: _frozen, ...rest } = card;
          movedCard = rest;
        }
        p.zones[to] = [...dst, movedCard];
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

    /**
     * 重置阶段（docs/16 §2 / ADR-0025）：
     * **霜冻单位跳过重置**，其余解除休眠。
     */
    case 'units:reset':
      return withPlayer(state, s(event, 'playerId'), (p) => {
        p.zones.board = p.zones.board.map((c) => (c.frozen ? c : { ...c, sleeping: false }));
      });

    /** 霜冻（docs/12 §5 / ADR-0025）：立即休眠并打上状态位；重复冻结只刷新，不叠加。 */
    case 'unit:frozen': {
      const id = s(event, 'playerId');
      const uid = s(event, 'uid');
      return withPlayer(state, id, (p) => {
        p.zones.board = p.zones.board.map((c) =>
          c.uid === uid ? { ...c, frozen: true, sleeping: true } : c,
        );
      });
    }

    /** 费用支付记帐（docs/16 §3.3）：本回合已消耗张数累加。 */
    case 'cost:spent':
      return withPlayer(state, s(event, 'playerId'), (p) => {
        p.usedCostThisTurn += Math.max(0, n(event, 'amount'));
      });

    /** 指挥官攻击（docs/16 §6.1）：本回合一次。 */
    case 'commander:attacked':
      return withPlayer(state, s(event, 'playerId'), (p) => {
        p.commanderAttacked = true;
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
          const ar = event.payload?.['attackRefresh'];
          if (ar === true) next.attackRefresh = true;
          // H23：「一回合一次，攻击后重置」生效后由 attack.ts 发 false 消耗
          if (ar === false) delete next.attackRefresh;
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
      // docs/12 §5.2 / ADR-0025：霜冻在**其控制者回合的结束阶段**解除（仍休眠）。
      if (to === 'end') {
        const active = next.seats[next.activeSeat];
        if (active) {
          next = withPlayer(next, active, (p) => {
            p.zones.board = p.zones.board.map((c) => {
              if (!c.frozen) return c;
              const { frozen: _frozen, ...rest } = c;
              return rest;
            });
          });
        }
      }
      // ⚠️ `effectsUsed` 的「每回合一次」重置已移到 `turn:changed`（发给**拿到回合**的人）：
      // 此处 activeSeat 还是刚结束回合的人（advanceOnce 先发 phase:changed 再发 turn:changed）。
      return next;
    }

    /** 手动抽牌完成（`draw.ts`）—— 标记本阶段已抽，允许推进到下一阶段。 */
    case 'draw:completed':
      return { ...state, drawnThisPhase: true };

    case 'turn:changed': {
      // 回合切换 = 「本回合」词缀的边界（ADR-0023 §3）：
      // 清空全场卡的临时修正与双方触发器。
      const players: GameState['players'] = {};
      const nextSeat = n(event, 'activeSeat');
      for (const [id, p] of Object.entries(state.players)) {
        const incoming = id === state.seats[nextSeat];
        players[id] = {
          ...p,
          // X-17：新回合从充能阶段开始（advanceOnce 的 end→charge 路径）。
          // 行动方拿到回合 = 充能次数 +1；首次拿到回合的时刻 = 其换牌时间窗起点。
          chargeCount: incoming ? p.chargeCount + 1 : p.chargeCount,
          firstChargeAt: incoming ? (p.firstChargeAt ?? event.at) : p.firstChargeAt,
          // ADR-0023 §3 / docs/16 §3.3：回合级记帐换人即清零。
          effectsUsed: incoming ? [] : p.effectsUsed,
          usedCostThisTurn: incoming ? 0 : p.usedCostThisTurn,
          commanderAttacked: incoming ? false : p.commanderAttacked,
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
      // startedAt = 对局开局时刻；先攻方开局即处于己方第一个充能阶段（没有「进入」
      // 动作，ADR-0016 §3），其充能计数与换牌窗基准（X-17）在此一并写入。
      let next: GameState = { ...state, seats, activeSeat: 0, started: true, startedAt: event.at };
      const first = seats[0];
      if (first) {
        next = withPlayer(next, first, (p) => {
          p.firstChargeAt = event.at;
          p.chargeCount = 1;
        });
      }
      return next;
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

    case 'game:ended': {
      const winner = s(event, 'winner');
      // docs/16 §7：40 轮判和 —— winner 为空 + reason='draw'。
      return { ...state, winner: winner || null, draw: winner === '' && s(event, 'reason') === 'draw' };
    }

    default:
      // 未知事件不改变状态 —— 但也不静默吞掉：交由上层核对事件白名单
      return state;
  }
}
