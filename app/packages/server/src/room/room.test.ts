import { describe, expect, it } from 'vitest';

import { DEFAULT_MAIN_DECK } from '../deck-pool.js';
import { BASIC_DECKS } from '@app/shared/default-decks';
import { TURN_TIMEOUT_MS } from '@app/shared/constants';

import { RoomManager } from './room.js';
import type { Clock, IdGen } from './types.js';

/** 可控时钟与确定性 ID —— 让全部超时与房间码行为可断言。 */
function harness(start = 1_000_000) {
  const state = { t: start };
  const clock: Clock = { now: () => state.t };
  let n = 0;
  const ids: IdGen = {
    id: () => `p${++n}`,
    token: () => `t${++n}`,
    code: () => `C${(++n).toString(36).toUpperCase()}`,
  };
  const manager = new RoomManager({ clock, ids });
  return { manager, state, advance: (ms: number) => (state.t += ms) };
}

describe('RoomManager · 建房与加入', () => {
  it('建房返回房间码、房主席位与凭据', () => {
    const { manager } = harness();
    const r = manager.create({ nickname: 'Era', capacity: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.room.code).toBeTruthy();
    expect(r.value.room.hostId).toBe(r.value.seat.playerId);
    expect(r.value.seat.seat).toBe(0);
    expect(r.value.room.seats.filter(Boolean)).toHaveLength(1);
  });

  it('加入后满员，第三人被拒为 ROOM_FULL', () => {
    const { manager } = harness();
    const created = manager.create({ nickname: 'A', capacity: 2 });
    if (!created.ok) throw new Error('create failed');
    const code = created.value.room.code;

    expect(manager.join({ code, nickname: 'B' }).ok).toBe(true);
    const third = manager.join({ code, nickname: 'C' });
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.error).toBe('ROOM_FULL');
  });

  it('房间码不存在返回 ROOM_NOT_FOUND', () => {
    const { manager } = harness();
    const r = manager.join({ code: 'NOPE', nickname: 'X' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('ROOM_NOT_FOUND');
  });

  it('房间视图不泄漏重连凭据', () => {
    const { manager } = harness();
    const created = manager.create({ nickname: 'A', capacity: 2 });
    if (!created.ok) throw new Error('create failed');
    const view = manager.publicView(created.value.room);
    expect(JSON.stringify(view)).not.toContain(created.value.seat.token);
  });
});

/** 自建卡组（D-141）—— 建房 / 加入 / 准备页换卡组。 */
describe('RoomManager · 自建卡组（D-141）', () => {
  const legal = [...DEFAULT_MAIN_DECK];

  it('建房带合法卡组 → 席位保存；房间视图只暴露张数', () => {
    const { manager } = harness();
    const r = manager.create({ nickname: 'A', capacity: 2, deck: legal });
    if (!r.ok) throw new Error('create failed');
    expect(r.value.seat.deck).toHaveLength(30);
    const view = manager.publicView(r.value.room);
    expect(view.seats[0]?.deckSize).toBe(30);
    // 30 个 defId 不随视图下发
    expect(JSON.stringify(view)).not.toContain('bladeScout');
  });

  it('张数不对 → INVALID_DECK（人话原因）', () => {
    const { manager } = harness();
    const r = manager.create({ nickname: 'A', capacity: 2, deck: legal.slice(0, 29) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('INVALID_DECK');
      expect(r.message).toContain('30');
    }
  });

  it('同名超过 3 张 → INVALID_DECK', () => {
    const { manager } = harness();
    const bad = Array.from({ length: 30 }, () => 'bladeScout');
    const r = manager.create({ nickname: 'A', capacity: 2, deck: bad });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('同名');
  });

  it('主卡组含指挥官 → INVALID_DECK', () => {
    const { manager } = harness();
    const bad = Array.from({ length: 30 }, () => 'bladeScout');
    bad[0] = 'bladeLord';
    const r = manager.create({ nickname: 'A', capacity: 2, deck: bad });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('指挥官');
  });

  it('加入时也能带卡组', () => {
    const { manager } = harness();
    const created = manager.create({ nickname: 'A', capacity: 2 });
    if (!created.ok) throw new Error('create failed');
    const joined = manager.join({
      code: created.value.room.code,
      nickname: 'B',
      deck: legal,
    });
    if (!joined.ok) throw new Error('join failed');
    expect(joined.value.seat.deck).toHaveLength(30);
  });

  it('准备页换卡组：未开局可改，空数组回到默认卡组', () => {
    const { manager } = harness();
    const created = manager.create({ nickname: 'A', capacity: 2 });
    if (!created.ok) throw new Error('create failed');
    const playerId = created.value.seat.playerId;

    const set = manager.setDeck(created.value.room.id, playerId, legal);
    expect(set.ok).toBe(true);
    if (set.ok) expect(set.value.seats[0]?.deck).toHaveLength(30);

    const reset = manager.setDeck(created.value.room.id, playerId, []);
    expect(reset.ok).toBe(true);
    if (reset.ok) expect(reset.value.seats[0]?.deck).toBeUndefined();
  });

  it('开局后换卡组被拒为 DECK_LOCKED', () => {
    const { manager } = harness();
    const created = manager.create({ nickname: 'A', capacity: 2 });
    if (!created.ok) throw new Error('create failed');
    const playerId = created.value.seat.playerId;
    // 开局后 phase 由 startGame 置为 playing（index.ts）；这里直接改内存对象模拟。
    created.value.room.phase = 'playing';

    const r = manager.setDeck(created.value.room.id, playerId, legal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('DECK_LOCKED');
  });

  it('BO3 局间换卡组被拒（H37 / Era 2026-10-20：不允许更换卡组）', () => {
    const { manager } = harness();
    const created = manager.create({ nickname: 'A', capacity: 2, format: 'bo3' });
    if (!created.ok) throw new Error('create failed');
    const room = created.value.room;
    const playerId = created.value.seat.playerId;

    // 打完第 1 小局 → awaitingNext（房间仍是 playing）
    room.phase = 'playing';
    manager.recordGameResult(room.id, playerId);
    expect(room.awaitingNext).toBe(true);

    const duringBreak = manager.setDeck(room.id, playerId, legal);
    expect(duringBreak.ok).toBe(false);
    if (!duringBreak.ok) {
      expect(duringBreak.error).toBe('DECK_LOCKED');
      expect(duringBreak.message).toContain('两局之间');
    }

    // 关键：即使将来把局间房间改回 lobby，也不得放开 —— 单独判 awaitingNext 而不是只判 phase
    room.phase = 'lobby';
    const stillLocked = manager.setDeck(room.id, playerId, legal);
    expect(stillLocked.ok).toBe(false);
    if (!stillLocked.ok) expect(stillLocked.error).toBe('DECK_LOCKED');
  });
});

describe('RoomManager · 断线保留与重连', () => {
  it('断线后席位保留，60s 内重连成功并带回 lastSeq', () => {
    const { manager, advance } = harness();
    const created = manager.create({ nickname: 'A', capacity: 2 });
    if (!created.ok) throw new Error('create failed');
    const { playerId, token } = created.value.seat;

    expect(manager.markDisconnected(playerId).ok).toBe(true);
    advance(30_000);
    const back = manager.reconnect({ playerId, token });
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.value.lastSeq).toBe(0);
  });

  it('超出保留窗口（61s）重连被拒为 GRACE_EXPIRED', () => {
    const { manager, advance } = harness();
    const created = manager.create({ nickname: 'A', capacity: 2 });
    if (!created.ok) throw new Error('create failed');
    const { playerId, token } = created.value.seat;

    manager.markDisconnected(playerId);
    advance(61_000);
    const back = manager.reconnect({ playerId, token });
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.error).toBe('GRACE_EXPIRED');
  });

  it('凭据不符返回 INVALID_TOKEN', () => {
    const { manager } = harness();
    const created = manager.create({ nickname: 'A', capacity: 2 });
    if (!created.ok) throw new Error('create failed');
    const r = manager.reconnect({ playerId: created.value.seat.playerId, token: 'wrong' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('INVALID_TOKEN');
  });

  it('prune 释放超时席位，房间空了则销毁', () => {
    const { manager, advance } = harness();
    const created = manager.create({ nickname: 'A', capacity: 2 });
    if (!created.ok) throw new Error('create failed');
    const { playerId } = created.value.seat;
    const code = created.value.room.code;

    manager.markDisconnected(playerId);
    advance(61_000);
    // D-233：prune 的回包带上 roomId，会话层据此广播房间状态并按「已离开」收尾对局。
    expect(manager.prune()).toEqual([{ playerId, roomId: created.value.room.id }]);
    expect(manager.getRoomByCode(code)).toBeUndefined();
  });

  it('保留窗口内 prune 不释放席位', () => {
    const { manager, advance } = harness();
    const created = manager.create({ nickname: 'A', capacity: 2 });
    if (!created.ok) throw new Error('create failed');
    manager.markDisconnected(created.value.seat.playerId);
    advance(59_000);
    expect(manager.prune()).toEqual([]);
    expect(manager.getRoom(created.value.room.id)).toBeDefined();
  });
});

describe('RoomManager · 离开与房主移交', () => {
  it('房主离开后房主移交给在场玩家', () => {
    const { manager } = harness();
    const created = manager.create({ nickname: 'A', capacity: 2 });
    if (!created.ok) throw new Error('create failed');
    const code = created.value.room.code;
    const host = created.value.seat.playerId;
    const joined = manager.join({ code, nickname: 'B' });
    if (!joined.ok) throw new Error('join failed');

    manager.leave(host);
    const room = manager.getRoomByCode(code);
    expect(room).toBeDefined();
    expect(room?.hostId).toBe(joined.value.seat.playerId);
    expect(room?.seats[0]).toBeNull();
  });

  it('最后一人离开则房间销毁', () => {
    const { manager } = harness();
    const created = manager.create({ nickname: 'A', capacity: 2 });
    if (!created.ok) throw new Error('create failed');
    manager.leave(created.value.seat.playerId);
    expect(manager.getRoomByCode(created.value.room.code)).toBeUndefined();
  });

  it('不在房间内离开返回 NOT_IN_ROOM', () => {
    const { manager } = harness();
    const r = manager.leave('ghost');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('NOT_IN_ROOM');
  });
});

describe('RoomManager · 赛制与系列赛（D-132）', () => {
  /** 建一个 BO3 房并拉满两席。 */
  function bo3() {
    const h = harness();
    const created = h.manager.create({
      nickname: 'A',
      capacity: 2,
      format: 'bo3',
      commander: 'bladeLord',
    });
    if (!created.ok) throw new Error('create failed');
    const joined = h.manager.join({
      code: created.value.room.code,
      nickname: 'B',
      commander: 'starWatcher',
    });
    if (!joined.ok) throw new Error('join failed');
    return {
      ...h,
      roomId: created.value.room.id,
      host: created.value.seat.playerId,
      guest: joined.value.seat.playerId,
    };
  }

  it('默认 BO1；显式 BO3 会被记录，指挥官随席位保存', () => {
    const { manager } = harness();
    const bo1 = manager.create({ nickname: 'A', capacity: 2 });
    if (!bo1.ok) throw new Error('create failed');
    expect(bo1.value.room.format).toBe('bo1');

    const s = bo3();
    const room = s.manager.getRoom(s.roomId)!;
    expect(room.format).toBe('bo3');
    expect(room.seats[0]!.commander).toBe('bladeLord');
    expect(room.seats[1]!.commander).toBe('starWatcher');
  });

  it('BO1：一小局后房间直接结束', () => {
    const { manager } = harness();
    const created = manager.create({ nickname: 'A', capacity: 2 });
    if (!created.ok) throw new Error('create failed');
    const joined = manager.join({ code: created.value.room.code, nickname: 'B' });
    if (!joined.ok) throw new Error('join failed');
    const room = manager.recordGameResult(created.value.room.id, created.value.seat.playerId);
    expect(room?.phase).toBe('ended');
    expect(room?.seriesWinner).toBe(created.value.seat.playerId);
    expect(room?.awaitingNext).toBe(false);
  });

  it('BO3：1 胜后进入「等待下一局」，2 胜才结束', () => {
    const s = bo3();
    let room = s.manager.recordGameResult(s.roomId, s.host)!;
    expect(room.phase).toBe('playing');
    expect(room.awaitingNext).toBe(true);
    expect(room.wins[s.host]).toBe(1);
    expect(room.gameNo).toBe(1);

    room = s.manager.recordGameResult(s.roomId, s.guest)!;
    expect(room.awaitingNext).toBe(true);
    expect(room.gameNo).toBe(2);

    room = s.manager.recordGameResult(s.roomId, s.host)!;
    expect(room.phase).toBe('ended');
    expect(room.seriesWinner).toBe(s.host);
    expect(room.gameNo).toBe(3);
  });

  it('BO3：平局不计分但照样进入下一局', () => {
    const s = bo3();
    const room = s.manager.recordGameResult(s.roomId, null)!;
    expect(room.awaitingNext).toBe(true);
    expect(room.wins[s.host]).toBe(0);
    expect(room.wins[s.guest]).toBe(0);
    expect(room.gameNo).toBe(1);
  });

  it('下一局先手：第 2 小局换人，第 3 小局由上一小局败者先攻（H33）', () => {
    const s = bo3();
    const room = s.manager.getRoom(s.roomId)!;
    room.firstPlayers.push(s.host); // 第 1 小局先手 = host
    s.manager.recordGameResult(s.roomId, s.host);
    expect(s.manager.nextFirstPlayer(s.roomId)).toBe(s.guest);

    s.manager.markNextGameStarted(s.roomId);
    room.firstPlayers.push(s.guest);
    s.manager.recordGameResult(s.roomId, s.guest); // 第 2 小局 guest 胜 → 败者 host
    expect(s.manager.getRoom(s.roomId)!.lastLoser).toBe(s.host);
    expect(s.manager.nextFirstPlayer(s.roomId)).toBe(s.host);
  });

  it('第 3 小局前判和时无败者 → 先手回落到掷骰（null）', () => {
    const s = bo3();
    s.manager.recordGameResult(s.roomId, s.host);
    s.manager.markNextGameStarted(s.roomId);
    s.manager.recordGameResult(s.roomId, null); // 判和
    expect(s.manager.getRoom(s.roomId)!.lastLoser).toBeNull();
    expect(s.manager.nextFirstPlayer(s.roomId)).toBeNull();
  });

  it('离场判负整个系列赛（不留「等待下一局」）', () => {
    const s = bo3();
    s.manager.recordGameResult(s.roomId, s.host);
    const room = s.manager.forfeitSeries(s.roomId, s.guest)!;
    expect(room.phase).toBe('ended');
    expect(room.awaitingNext).toBe(false);
    expect(room.seriesWinner).toBe(s.host);
  });
});

/**
 * `prune()` 的回收边界（D-181）。
 *
 * 它只回收 `connected: false` 且超过宽限期的席位 —— 这条契约本身是对的
 * （断线要保留 `RECONNECT_GRACE` 的重连窗口）。
 *
 * 反过来说：**标着 `connected: true` 的席位永远不会被回收**。所以「一条连接建多间房」
 * 必须由连接层主动释放旧席位，否则那些房间连同运行时永久滞留。
 * 2026-10-20 实测：单连接建 2000 间、断开后只回收最后一间，其余全滞留（约 17 MB）。
 */
describe('RoomManager · prune 的回收边界（D-181）', () => {
  it('仍标记为 connected 的席位不会被 prune 回收', () => {
    const { manager, advance } = harness();
    const a = manager.create({ nickname: 'A', capacity: 2 });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    // 注意：这里**不**调用 markDisconnected —— 模拟「连接层忘了释放」的旧席位
    advance(10 * 60_000);
    manager.prune();
    expect(manager.getRoom(a.value.room.id)).toBeDefined();
  });

  it('leave() 释放席位后房间立即销毁（连接层据此释放旧席位）', () => {
    const { manager } = harness();
    const a = manager.create({ nickname: 'A', capacity: 2 });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const r = manager.leave(a.value.seat.playerId);
    expect(r.ok).toBe(true);
    // 空房立即销毁，不必等 prune
    expect(manager.getRoom(a.value.room.id)).toBeUndefined();
  });
});

/* ------------------------------ 人机房（D-242） ------------------------------ */

describe('RoomManager · 人机房', () => {
  it('建房即坐入 AI：容量收到 2、席位满员、AI 已准备', () => {
    const { manager } = harness();
    const r = manager.create({ nickname: 'Era', capacity: 8, solo: true });
    if (!r.ok) throw new Error('create failed');

    const room = r.value.room;
    // 人数输入是 8，人机房必须被强制收到 2 —— 规则只验证过 2 人
    expect(room.capacity).toBe(2);
    expect(room.seats).toHaveLength(2);
    expect(room.seats[1]?.playerId).toBe('ai');
    expect(room.seats[1]?.nickname).toBe('电脑');
    // AI 永远就绪，否则玩家点准备也开不了局
    expect(room.seats[1]?.ready).toBe(true);
    // 系列赛比分要包含 AI 这一席
    expect(room.wins['ai']).toBe(0);
  });

  it('AI 用了一套合法的基础卡组 + 对应指挥官（能直接开局）', () => {
    const { manager } = harness();
    const r = manager.create({ nickname: 'Era', capacity: 2, solo: true });
    if (!r.ok) throw new Error('create failed');
    const ai = r.value.room.seats[1]!;
    expect(ai.deck).toHaveLength(30);
    expect(ai.commander).toBeTruthy();
    // 卡组与指挥官必须**成套** —— 否则开局会装配成「霜律指挥官 + 炎刃 30 张」。
    // 具体是哪一套由房间码散列决定，这里不断言系别，只断言配对正确。
    const basic = BASIC_DECKS.find((d) => d.commander === ai.commander);
    expect(basic).toBeTruthy();
    expect(ai.deck).toEqual(basic!.deck);
  });

  it('AI 不泄漏卡组内容给客户端（只给张数）', () => {
    const { manager } = harness();
    const r = manager.create({ nickname: 'Era', capacity: 2, solo: true });
    if (!r.ok) throw new Error('create failed');
    const view = manager.publicView(r.value.room);
    const aiView = view.seats[1] as Record<string, unknown>;
    expect(aiView['deckSize']).toBe(30);
    expect(aiView['deck']).toBeUndefined();
  });

  it('AI 席位不登记玩家绑定（不会被当成可重连的席位）', () => {
    const { manager } = harness();
    manager.create({ nickname: 'Era', capacity: 2, solo: true });
    expect(manager.locate('ai')).toBeNull();
  });

  it('真人离开后房间销毁（AI 不会把房间撑在内存里）', () => {
    const { manager } = harness();
    const r = manager.create({ nickname: 'Era', capacity: 2, solo: true });
    if (!r.ok) throw new Error('create failed');
    const humanId = r.value.seat.playerId;

    const left = manager.leave(humanId);
    expect(left.ok).toBe(true);
    if (!left.ok) return;
    expect(left.value.room).toBeNull();
    // 房间确实没了（否则每进一次人机房就泄漏一间）
    expect(manager.count()).toBe(0);
  });

  it('非人机房的建房行为不受影响（没有 AI 席位；容量统一收到 2，T-07）', () => {
    const { manager } = harness();
    const r = manager.create({ nickname: 'Era', capacity: 3 });
    if (!r.ok) throw new Error('create failed');
    // T-07 / D-244：规则只验证过 2 人，容量不再照传 —— 传 3 也建出双人房。
    expect(r.value.room.capacity).toBe(2);
    expect(r.value.room.seats).toHaveLength(2);
    expect(r.value.room.seats.every((s) => s === null || s.playerId !== 'ai')).toBe(true);
  });

  it('回合时限按建房选择记录，非法档位回落默认（H18）', () => {
    const { manager } = harness();
    const picked = manager.create({ nickname: 'A', capacity: 2, turnTimeoutMs: 180_000 });
    if (!picked.ok) throw new Error('create failed');
    expect(picked.value.room.turnTimeoutMs).toBe(180_000);
    // 视图里要能看到 —— 对手也得知道这局每回合给多久
    expect(manager.publicView(picked.value.room).turnTimeoutMs).toBe(180_000);

    // 未在白名单里的值不报错、回落默认（老客户端 / 手误不该被 400 挡住）
    const fallback = manager.create({ nickname: 'B', capacity: 2, turnTimeoutMs: 120_000 });
    if (!fallback.ok) throw new Error('create failed');
    expect(fallback.value.room.turnTimeoutMs).toBe(TURN_TIMEOUT_MS);
  });
});

/**
 * 再来一局（D-309 / #125）。
 *
 * 这一组钉住三件事，任何一条掉了都会让玩家原地卡住或替对手做决定：
 * ① 联机必须**双方都点**才开（单票只记票，并告诉对方「他在等你」）；
 * ② 人机房 AI 不会点按钮，玩家一票即开；
 * ③ 对手走了就不能静默失败 —— 必须回一个能说人话的错误码。
 */
describe('RoomManager · 再来一局（D-309 / #125）', () => {
  /** 一间打满两席的联机房（BO1 打完即 ended）。 */
  function duo() {
    const h = harness();
    const created = h.manager.create({ nickname: 'A', capacity: 2, commander: 'bladeLord' });
    if (!created.ok) throw new Error('create failed');
    const joined = h.manager.join({
      code: created.value.room.code,
      nickname: 'B',
      commander: 'starWatcher',
    });
    if (!joined.ok) throw new Error('join failed');
    const roomId = created.value.room.id;
    h.manager.recordGameResult(roomId, created.value.seat.playerId);
    return {
      ...h,
      roomId,
      host: created.value.seat.playerId,
      guest: joined.value.seat.playerId,
    };
  }

  it('联机：一人投票只记票，两人都投才开', () => {
    const s = duo();
    const first = s.manager.voteRematch(s.host);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.shouldStart).toBe(false);
    expect(first.value.waitingFor).toBe(s.guest);
    // 对手看得到「他点了」——否则只能干等，分不清对面有没有收到
    expect(s.manager.publicView(first.value.room).rematchVotes).toEqual([s.host]);

    const second = s.manager.voteRematch(s.guest);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.shouldStart).toBe(true);
    expect(second.value.waitingFor).toBeNull();
  });

  it('人机房：玩家一票即开（AI 没有按钮）', () => {
    const { manager } = harness();
    const r = manager.create({ nickname: 'Era', capacity: 2, solo: true });
    if (!r.ok) throw new Error('create failed');
    const me = r.value.seat.playerId;
    manager.recordGameResult(r.value.room.id, 'ai');

    const vote = manager.voteRematch(me);
    expect(vote.ok).toBe(true);
    if (!vote.ok) return;
    expect(vote.value.shouldStart).toBe(true);
    // 视图里要标明这是人机房 —— 客户端据此不显示「等待对手确认…」
    expect(manager.publicView(vote.value.room).solo).toBe(true);
  });

  it('一局还没打完时投票 = NO_REMATCH（不是静默失败）', () => {
    const { manager } = harness();
    const created = manager.create({ nickname: 'A', capacity: 2 });
    if (!created.ok) throw new Error('create failed');
    const vote = manager.voteRematch(created.value.seat.playerId);
    expect(vote.ok).toBe(false);
    if (vote.ok) return;
    expect(vote.error).toBe('NO_REMATCH');
  });

  it('对手已离开 → OPPONENT_LEFT，而不是开一间没有对手的对局', () => {
    const s = duo();
    s.manager.leave(s.guest);
    const vote = s.manager.voteRematch(s.host);
    expect(vote.ok).toBe(false);
    if (vote.ok) return;
    expect(vote.error).toBe('OPPONENT_LEFT');
  });

  it('对手掉线（席位还留着）→ OPPONENT_LEFT，等他回来', () => {
    const s = duo();
    s.manager.markDisconnected(s.guest);
    const vote = s.manager.voteRematch(s.host);
    expect(vote.ok).toBe(false);
    if (vote.ok) return;
    expect(vote.error).toBe('OPPONENT_LEFT');
  });

  it('resetForRematch：清比分与局数，席位 / 卡组 / 指挥官一律保留', () => {
    const s = duo();
    const before = s.manager.getRoom(s.roomId)!;
    const decksBefore = before.seats.map((x) => x?.deck ?? null);
    const cmdsBefore = before.seats.map((x) => x?.commander ?? null);

    s.manager.voteRematch(s.host);
    s.manager.resetForRematch(s.roomId);
    const room = s.manager.getRoom(s.roomId)!;

    expect(room.phase).toBe('lobby');
    expect(room.gameNo).toBe(0);
    expect(room.awaitingNext).toBe(false);
    expect(room.seriesWinner).toBeNull();
    expect(room.firstPlayers).toEqual([]);
    expect(room.lastLoser).toBeNull();
    expect(room.rematchVotes).toEqual([]);
    // 比分归零而不是清空键：双方都还在座，视图要能显示 0:0
    expect(room.wins).toEqual({ [s.host]: 0, [s.guest]: 0 });
    // 席位保留 = 「同一批人、同一套卡组」，这是 #125 验收 2 的核心
    expect(room.seats.map((x) => x?.deck ?? null)).toEqual(decksBefore);
    expect(room.seats.map((x) => x?.commander ?? null)).toEqual(cmdsBefore);
  });

  it('打完下一局会清掉上一批投票（BO3 里不会把人算成「已经同意」）', () => {
    const s = duo();
    s.manager.voteRematch(s.host);
    expect(s.manager.getRoom(s.roomId)!.rematchVotes).toEqual([s.host]);
    s.manager.recordGameResult(s.roomId, s.guest);
    expect(s.manager.getRoom(s.roomId)!.rematchVotes).toEqual([]);
  });
});
