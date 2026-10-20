import { describe, expect, it } from 'vitest';

import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, makeRoomCode } from './code.js';

/**
 * 房间码（D-178）。
 *
 * 钉住三件事：长度固定、字符集不含易混字符、生成不重复（不是「永不重复」——
 * 那是概率断言，只要求大量采样下冲突极少）。
 */
describe('房间码', () => {
  it('长度恒为 6', () => {
    for (let i = 0; i < 500; i++) {
      expect(makeRoomCode()).toHaveLength(ROOM_CODE_LENGTH);
    }
  });

  it('只使用 32 字符表里的字符', () => {
    for (let i = 0; i < 500; i++) {
      for (const ch of makeRoomCode()) {
        expect(ROOM_CODE_ALPHABET).toContain(ch);
      }
    }
  });

  it('不含 0 / O / 1 / I 这些口头报码易混字符', () => {
    expect(ROOM_CODE_ALPHABET).not.toMatch(/[0O1I]/);
  });

  it('500 次生成几乎不重复', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(makeRoomCode());
    // 32^6 ≈ 10.7 亿，500 次采样按生日问题算，碰撞概率远低于千分之一
    expect(seen.size).toBeGreaterThan(498);
  });

  it('能通过前端校验用的正则', () => {
    // client 的输入校验与 E2E 断言都用这个形状
    expect(makeRoomCode()).toMatch(/^[A-Z0-9]{4,8}$/);
  });
});
