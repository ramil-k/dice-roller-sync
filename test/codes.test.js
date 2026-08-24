import { describe, expect, it } from 'vitest';
import { isValidCode, newCode } from '../src/codes.js';

describe('codes', () => {
  it('generates valid, reasonably distinct codes', () => {
    const codes = new Set(Array.from({ length: 50 }, newCode));
    for (const code of codes) expect(isValidCode(code)).toBe(true);
    expect(codes.size).toBeGreaterThan(40);
  });

  it('rejects junk', () => {
    for (const bad of ['', 'x', '../etc', 'Brave-Otter-1234', 'a-b-12', 'a-b-12345', null]) {
      expect(isValidCode(bad)).toBe(false);
    }
  });
});
