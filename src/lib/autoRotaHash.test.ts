import { describe, expect, it } from 'vitest';
import { fnv1a32, weeklyTieBreakKey } from './autoRotaHash';

// An independent reference (BigInt, no Math.imul) to cross-check the real implementation.
function referenceFnv1a32(text: string): number {
  let hash = 0x811c9dc5n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x01000193n) & 0xffffffffn;
  }
  return Number(hash);
}

describe('fnv1a32 (the Auto-Rota weekly tie-break hash)', () => {
  it('14. matches the published FNV-1a 32-bit test vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  it('14. pins the real tie-break inputs -- a change here silently changes every future plan', () => {
    expect(weeklyTieBreakKey('2030-01-07', 'driver-a')).toBe(997340708);
    expect(weeklyTieBreakKey('2030-01-07', 'driver-b')).toBe(1047673565);
    expect(weeklyTieBreakKey('2030-01-14', 'driver-a')).toBe(415374872);
    expect(weeklyTieBreakKey('2030-01-14', 'driver-b')).toBe(465707729);
    expect(weeklyTieBreakKey('2030-01-07', 'alex')).toBe(44470556);
    expect(weeklyTieBreakKey('2030-01-07', 'bea')).toBe(2998891508);
    expect(weeklyTieBreakKey('2030-01-07', '550e8400-e29b-41d4-a716-446655440000')).toBe(880252469);
  });

  it('agrees with an independent BigInt implementation on many inputs, always as an unsigned 32-bit integer', () => {
    const samples = ['', 'a', 'ab', '2030-01-07:driver-a', 'ünïcode:driver', '日本語', '2031-12-29:ffffffff-ffff-ffff-ffff-ffffffffffff'];
    for (let i = 0; i < 200; i += 1) samples.push(`2030-${String((i % 12) + 1).padStart(2, '0')}-07:driver-${i}`);
    for (const text of samples) {
      const value = fnv1a32(text);
      expect(value).toBe(referenceFnv1a32(text));
      expect(Number.isInteger(value) && value >= 0 && value <= 0xffffffff).toBe(true);
    }
  });

  it('is deterministic and week-sensitive: the same inputs always agree, and the order of two drivers can flip from week to week', () => {
    expect(weeklyTieBreakKey('2030-01-07', 'driver-a')).toBe(weeklyTieBreakKey('2030-01-07', 'driver-a'));
    const aFirst = (week: string) => weeklyTieBreakKey(week, 'driver-a') < weeklyTieBreakKey(week, 'driver-b');
    expect(aFirst('2030-01-07')).toBe(true);
    expect(aFirst('2030-01-28')).toBe(false); // the rotation that stops one driver winning every tie, every week
  });
});
