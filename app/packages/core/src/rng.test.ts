import { describe, expect, it } from 'vitest';
import { nextFloat, nextInt, seedFrom, shuffle } from './rng.js';

describe('rng 确定性', () => {
  it('同种子两次运行输出一致', () => {
    const seed = seedFrom('demo-seed-001');
    const seqA: number[] = [];
    const seqB: number[] = [];

    let c = seed;
    for (let i = 0; i < 20; i++) {
      const step = nextFloat(c);
      c = step.nextCursor;
      seqA.push(step.value);
    }
    c = seed;
    for (let i = 0; i < 20; i++) {
      const step = nextFloat(c);
      c = step.nextCursor;
      seqB.push(step.value);
    }

    expect(seqA).toEqual(seqB);
  });

  it('不同种子产生不同序列', () => {
    const a = nextFloat(seedFrom('aaa'));
    const b = nextFloat(seedFrom('bbb'));
    expect(a.value).not.toBe(b.value);
  });

  it('取值落在 [0,1)', () => {
    let c = seedFrom('range');
    for (let i = 0; i < 200; i++) {
      const step = nextFloat(c);
      c = step.nextCursor;
      expect(step.value).toBeGreaterThanOrEqual(0);
      expect(step.value).toBeLessThan(1);
    }
  });

  it('nextInt 落在 [0,max)', () => {
    let c = seedFrom('int');
    for (let i = 0; i < 200; i++) {
      const step = nextInt(c, 6);
      c = step.nextCursor;
      expect(step.value).toBeGreaterThanOrEqual(0);
      expect(step.value).toBeLessThan(6);
      expect(Number.isInteger(step.value)).toBe(true);
    }
  });

  it('shuffle 可复现且不改变入参', () => {
    const deck = Array.from({ length: 30 }, (_, i) => i);
    const snapshot = [...deck];

    const first = shuffle(seedFrom('deck'), deck);
    const second = shuffle(seedFrom('deck'), deck);

    expect(first.items).toEqual(second.items);
    expect(first.nextCursor).toBe(second.nextCursor);
    expect(deck).toEqual(snapshot);
    expect([...first.items].sort((a, b) => a - b)).toEqual(snapshot);
  });
});
