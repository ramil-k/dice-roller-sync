// The combat journal store: validation, append-only sequencing, reload,
// tolerant reads and the text export.
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createEventStore,
  formatEventLine,
  formatEventsText,
  validateBatch,
  validateEvent,
  MAX_BATCH_EVENTS,
  MAX_EVENT_BYTES,
} from '../src/events.js';

const by = { name: 'Ramil', color: '#58b7d8' };
const roll = { type: 'roll', by, data: { formula: '1d20+5', total: 17, faces: [12], label: 'attack' } };

describe('validateEvent', () => {
  it('normalizes a good event and keeps extra data fields', () => {
    const { event } = validateEvent({ ...roll, data: { ...roll.data, extra: 1 }, seq: 99, t: 'spoofed' });
    expect(event).toEqual({ type: 'roll', by, data: { ...roll.data, extra: 1 } });
    expect(event.seq).toBeUndefined(); // the server assigns these
  });

  it('clips names, drops bad colors, allows anonymous events', () => {
    const long = 'x'.repeat(200);
    expect(validateEvent({ type: 'hp', by: { name: long, color: 'red' } }).event.by).toEqual({ name: 'x'.repeat(64), color: null });
    expect(validateEvent({ type: 'combat-reset' }).event).toEqual({ type: 'combat-reset', by: null, data: {} });
  });

  it('rejects unknown types, bad shapes and oversized events', () => {
    expect(validateEvent({ type: 'teleport', data: {} }).error).toMatch(/unknown event type/);
    expect(validateEvent({ type: 'roll', data: [] }).error).toMatch(/data/);
    expect(validateEvent({ type: 'roll', by: 'Ramil' }).error).toMatch(/by/);
    expect(validateEvent({ type: 'roll', by: { color: '#fff' } }).error).toMatch(/by\.name/);
    expect(validateEvent(null).error).toBeTruthy();
    expect(validateEvent({ type: 'roll', data: { blob: 'x'.repeat(MAX_EVENT_BYTES) } }).error).toBe('event too large');
  });
});

describe('validateBatch', () => {
  it('accepts { events } and a bare array, reports the offending index', () => {
    expect(validateBatch({ events: [roll] }).events).toHaveLength(1);
    expect(validateBatch([roll, roll]).events).toHaveLength(2);
    expect(validateBatch({ events: [roll, { type: 'nope' }] }).error).toMatch(/^events\[1\]/);
  });

  it('rejects empty, non-array and too long batches', () => {
    expect(validateBatch({}).error).toBeTruthy();
    expect(validateBatch({ events: [] }).error).toBe('empty batch');
    expect(validateBatch({ events: Array(MAX_BATCH_EVENTS + 1).fill(roll) }).error).toMatch(/more than/);
  });
});

describe('createEventStore', () => {
  const fresh = () => createEventStore(mkdtempSync(join(tmpdir(), 'drs-events-')));

  it('assigns increasing seq across batches and stamps the server time', () => {
    const store = fresh();
    const t0 = new Date('2026-11-09T10:00:00Z');
    const a = store.append('brave-otter-1234', validateBatch([roll, roll]).events, { now: () => t0 });
    expect(a.map((e) => e.seq)).toEqual([1, 2]);
    expect(a[0].t).toBe(t0.toISOString());
    const b = store.append('brave-otter-1234', validateBatch([roll]).events);
    expect(b[0].seq).toBe(3);
    // rooms do not share counters
    expect(store.append('calm-lynx-0001', validateBatch([roll]).events)[0].seq).toBe(1);
    expect(store.lastSeq('brave-otter-1234')).toBe(3);
  });

  it('reads everything or only what came after `since`, and survives a reload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drs-events-'));
    const store = createEventStore(dir);
    store.append('r-r-0001', validateBatch([roll, roll, roll]).events);
    expect(store.read('r-r-0001').map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(store.read('r-r-0001', { since: 2 }).map((e) => e.seq)).toEqual([3]);
    expect(store.read('other-room-0000')).toEqual([]);

    const reloaded = createEventStore(dir);
    expect(reloaded.append('r-r-0001', validateBatch([roll]).events)[0].seq).toBe(4);
    expect(readFileSync(join(dir, 'r-r-0001.ndjson'), 'utf8').trim().split('\n')).toHaveLength(4);
  });

  it('skips a truncated last line instead of failing the whole read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drs-events-'));
    const store = createEventStore(dir);
    store.append('r-r-0002', validateBatch([roll]).events);
    appendFileSync(join(dir, 'r-r-0002.ndjson'), '{"seq":2,"type":"ro');
    expect(createEventStore(dir).read('r-r-0002').map((e) => e.seq)).toEqual([1]);
    expect(createEventStore(dir).append('r-r-0002', validateBatch([roll]).events)[0].seq).toBe(2);
  });
});

describe('text export', () => {
  const ev = (seq, type, data, name = 'Ramil') => ({ seq, t: '2026-11-09T10:00:00.000Z', by: name ? { name, color: null } : null, type, data });

  it('prints one readable chronological line per event', () => {
    const text = formatEventsText([
      ev(1, 'token-add', { nodeId: 'a', name: 'Goblin', kind: 'monster', hp: 7, hpMax: 7 }),
      ev(2, 'roll', { formula: '1d20+5', total: 17, faces: [12], label: 'attack' }),
      ev(3, 'hp', { nodeId: 'a', name: 'Goblin', from: 7, to: 0 }),
      ev(4, 'initiative', { nodeId: 'a', name: 'Goblin', value: 14 }),
      ev(5, 'turn', { round: 2, activeNodeId: 'a', activeName: 'Goblin' }),
      ev(6, 'rename', { nodeId: 'a', from: 'Goblin', to: 'Grik' }),
      ev(7, 'token-remove', { nodeId: 'a', name: 'Grik' }),
      ev(8, 'combat-reset', {}, null),
    ]);
    expect(text.split('\n')).toEqual([
      '#1 2026-11-09T10:00:00.000Z token-add: Ramil adds monster Goblin (HP 7)',
      '#2 2026-11-09T10:00:00.000Z roll: Ramil rolls 1d20+5 for attack: 17 [12]',
      '#3 2026-11-09T10:00:00.000Z hp: Goblin takes 7 damage (HP 7 -> 0), down - by Ramil',
      '#4 2026-11-09T10:00:00.000Z initiative: Goblin initiative 14 - by Ramil',
      "#5 2026-11-09T10:00:00.000Z turn: round 2: Goblin's turn - by Ramil",
      '#6 2026-11-09T10:00:00.000Z rename: Ramil renames Goblin to Grik',
      '#7 2026-11-09T10:00:00.000Z token-remove: Ramil removes Grik',
      '#8 2026-11-09T10:00:00.000Z combat-reset: someone resets the combat',
      '',
    ]);
  });

  it('describes healing and falls back to raw data for an unexpected type', () => {
    expect(formatEventLine(ev(1, 'hp', { name: 'Aria', from: 3, to: 10 }))).toContain('Aria heals 7 (HP 3 -> 10)');
    expect(formatEventLine(ev(2, 'teleport', { x: 1 }))).toContain('Ramil teleport {"x":1}');
    expect(formatEventsText([])).toBe('');
  });
});
