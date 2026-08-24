import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRegistry } from '../src/registry.js';

describe('registry', () => {
  it('creates rooms and persists them across reloads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drs-'));
    const reg = createRegistry(dir);
    const code = reg.create();
    expect(reg.has(code)).toBe(true);
    expect(reg.has('brave-otter-0000')).toBe(false);

    const reloaded = createRegistry(dir);
    expect(reloaded.has(code)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'rooms.json'), 'utf8')).rooms[code]).toBeTruthy();
  });
});
