import { describe, expect, it } from 'vitest';

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

  it('下一局先手：第 2 小局换人，第 3 小局重新掷骰（null）', () => {
    const s = bo3();
    const room = s.manager.getRoom(s.roomId)!;
    room.firstPlayers.push(s.host); // 第 1 小局先手 = host
    s.manager.recordGameResult(s.roomId, s.host);
    expect(s.manager.nextFirstPlayer(s.roomId)).toBe(s.guest);

    s.manager.markNextGameStarted(s.roomId);
    room.firstPlayers.push(s.guest);
    s.manager.recordGameResult(s.roomId, s.guest);
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
