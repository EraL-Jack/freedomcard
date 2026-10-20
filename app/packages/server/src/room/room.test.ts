import { describe, expect, it } from 'vitest';

import { DEFAULT_MAIN_DECK } from '../deck-pool.js';

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

  it('准备页换卡组：未开局可改，空数组回到阵营默认', () => {
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
    expect(manager.prune()).toEqual([playerId]);
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
    const created = h.manager.create({ nickname: 'A', capacity: 2, format: 'bo3', faction: 'blade' });
    if (!created.ok) throw new Error('create failed');
    const joined = h.manager.join({
      code: created.value.room.code,
      nickname: 'B',
      faction: 'star',
    });
    if (!joined.ok) throw new Error('join failed');
    return {
      ...h,
      roomId: created.value.room.id,
      host: created.value.seat.playerId,
      guest: joined.value.seat.playerId,
    };
  }

  it('默认 BO1；显式 BO3 会被记录，阵营随席位保存', () => {
    const { manager } = harness();
    const bo1 = manager.create({ nickname: 'A', capacity: 2 });
    if (!bo1.ok) throw new Error('create failed');
    expect(bo1.value.room.format).toBe('bo1');

    const s = bo3();
    const room = s.manager.getRoom(s.roomId)!;
    expect(room.format).toBe('bo3');
    expect(room.seats[0]!.faction).toBe('blade');
    expect(room.seats[1]!.faction).toBe('star');
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
