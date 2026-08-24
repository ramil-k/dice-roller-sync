// End-to-end over a real socket: REST room lifecycle, ws gate, and the CRDT
// property the whole project exists for - concurrent edits to different
// fields both survive.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let server;
let base;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'drs-data-'));
  const { createSyncServer } = await import('../src/server.js');
  server = createSyncServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((res) => server.close(res)));

const connect = (room) => {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`${base.replace('http', 'ws')}/ws`, room, doc, {
    WebSocketPolyfill: WebSocket,
  });
  const synced = new Promise((res) => provider.once('sync', res));
  return { doc, provider, synced };
};

const until = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('sync server', () => {
  it('serves health', async () => {
    expect((await (await fetch(`${base}/health`)).json()).ok).toBe(true);
  });

  it('creates rooms over REST and reports existence', async () => {
    const { code } = await (await fetch(`${base}/rooms`, { method: 'POST' })).json();
    expect(code).toMatch(/^[a-z]+-[a-z]+-\d{4}$/);
    expect((await fetch(`${base}/rooms/${code}`)).status).toBe(200);
    expect((await fetch(`${base}/rooms/nope-nope-0000`)).status).toBe(404);
  });

  it('rejects ws connections to unknown rooms', async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/nope-nope-0000`);
    const err = await new Promise((res) => {
      ws.on('error', res);
      ws.on('open', () => res(null));
    });
    expect(err).toBeTruthy();
  });

  it('merges concurrent edits to different fields without losing either', async () => {
    const { code } = await (await fetch(`${base}/rooms`, { method: 'POST' })).json();
    const a = connect(code);
    const b = connect(code);
    await Promise.all([a.synced, b.synced]);

    // seed two "token nodes" from client A
    a.doc.transact(() => {
      const nodes = a.doc.getMap('nodes');
      for (const id of ['tok-a', 'tok-b']) {
        const n = new Y.Map();
        n.set('x', 0);
        n.set('ext.hp', 10);
        nodes.set(id, n);
      }
    });
    await until(() => b.doc.getMap('nodes').get('tok-b')?.get('ext.hp') === 10);

    // concurrent edits: A moves tok-a, B damages tok-b
    a.doc.getMap('nodes').get('tok-a').set('x', 128);
    b.doc.getMap('nodes').get('tok-b').set('ext.hp', 3);

    await until(
      () =>
        b.doc.getMap('nodes').get('tok-a').get('x') === 128 &&
        a.doc.getMap('nodes').get('tok-b').get('ext.hp') === 3,
    );

    a.provider.destroy();
    b.provider.destroy();
  });

  it('persists room state for late joiners after everyone left', async () => {
    const { code } = await (await fetch(`${base}/rooms`, { method: 'POST' })).json();
    const a = connect(code);
    await a.synced;
    a.doc.getMap('meta').set('combat.round', 7);
    await new Promise((r) => setTimeout(r, 300));
    a.provider.destroy();
    a.doc.destroy();
    await new Promise((r) => setTimeout(r, 200));

    const late = connect(code);
    await late.synced;
    await until(() => late.doc.getMap('meta').get('combat.round') === 7);
    late.provider.destroy();
  });
});
