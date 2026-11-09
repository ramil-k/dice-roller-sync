// The combat journal over a real socket: room gate, batches, seq order,
// `since`, limits and the text export.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_BATCH_BYTES, MAX_BATCH_EVENTS } from '../src/events.js';

let server;
let base;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'drs-events-routes-'));
  const { createSyncServer } = await import('../src/server.js');
  server = createSyncServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((res) => server.close(res)));

const newRoom = async () => (await (await fetch(`${base}/rooms`, { method: 'POST' })).json()).code;
const post = (room, body, raw = false) =>
  fetch(`${base}/rooms/${room}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? body : JSON.stringify(body),
  });
const get = (room, query = '') => fetch(`${base}/rooms/${room}/events${query}`);

const by = { name: 'Ramil', color: '#58b7d8' };
const roll = (total) => ({ type: 'roll', by, data: { formula: '1d20', total, faces: [total] } });

describe('event routes', () => {
  it('appends batches with server-assigned seq and time, in order, with CORS', async () => {
    const room = await newRoom();
    const a = await post(room, { events: [roll(3), roll(4)] });
    expect(a.status).toBe(201);
    expect(a.headers.get('access-control-allow-origin')).toBe('*');
    expect(await a.json()).toEqual({ first: 1, last: 2, count: 2 });
    const b = await post(room, [{ type: 'hp', by, data: { nodeId: 'x', name: 'Goblin', from: 7, to: 2 }, seq: 500, t: 'nope' }]);
    expect(await b.json()).toEqual({ first: 3, last: 3, count: 1 });

    const { events } = await (await get(room)).json();
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events.map((e) => e.data.total)).toEqual([3, 4, undefined]);
    expect(events[2]).toMatchObject({ type: 'hp', by, data: { name: 'Goblin', from: 7, to: 2 } });
    expect(Number.isNaN(Date.parse(events[2].t))).toBe(false);
    expect(events[0].t <= events[2].t).toBe(true);
  });

  it('GET ?since returns only later events; an empty room has an empty journal', async () => {
    const room = await newRoom();
    expect((await (await get(room)).json()).events).toEqual([]);
    await post(room, { events: [roll(1), roll(2), roll(3)] });
    expect((await (await get(room, '?since=2')).json()).events.map((e) => e.seq)).toEqual([3]);
    expect((await (await get(room, '?since=3')).json()).events).toEqual([]);
    expect((await (await get(room, '?since=junk')).json()).events).toHaveLength(3);
  });

  it('answers 404 for rooms that are not in the registry', async () => {
    expect((await post('nope-nope-0000', { events: [roll(1)] })).status).toBe(404);
    expect((await get('nope-nope-0000')).status).toBe(404);
    expect((await get('nope-nope-0000', '?format=text')).status).toBe(404);
  });

  it('rejects malformed bodies and oversized batches', async () => {
    const room = await newRoom();
    expect((await post(room, '{not json', true)).status).toBe(400);
    expect((await post(room, { events: [] })).status).toBe(400);
    expect((await post(room, { events: [{ type: 'teleport' }] })).status).toBe(400);
    expect((await post(room, { events: [{ type: 'roll', data: { pad: 'x'.repeat(5000) } }] })).status).toBe(400);
    expect((await post(room, { events: Array(MAX_BATCH_EVENTS + 1).fill(roll(1)) })).status).toBe(400);
    const huge = await post(room, `{"events":[${'1,'.repeat(MAX_BATCH_BYTES / 2)}1]}`, true);
    expect(huge.status).toBe(413);
    expect((await (await get(room)).json()).events).toEqual([]); // nothing slipped through
  });

  it('exports the journal as plain text, one line per event', async () => {
    const room = await newRoom();
    await post(room, {
      events: [
        { type: 'token-add', by, data: { nodeId: 'g', name: 'Goblin', kind: 'monster', hp: 7, hpMax: 7 } },
        roll(17),
        { type: 'hp', by: { name: 'Aня', color: '#e0464c' }, data: { nodeId: 'g', name: 'Goblin', from: 7, to: 0 } },
        { type: 'turn', by, data: { round: 2, activeNodeId: 'g', activeName: 'Goblin' } },
      ],
    });
    const res = await get(room, '?format=text');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    const lines = (await res.text()).trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^#1 \d{4}-\d{2}-\d{2}T.* token-add: Ramil adds monster Goblin \(HP 7\)$/);
    expect(lines[1]).toContain('roll: Ramil rolls 1d20: 17 [17]');
    expect(lines[2]).toContain('hp: Goblin takes 7 damage (HP 7 -> 0), down - by Aня');
    expect(lines[3]).toContain("turn: round 2: Goblin's turn");
    expect((await (await get(room, '?format=text&since=3')).text()).trimEnd().split('\n')).toHaveLength(1);
  });
});
