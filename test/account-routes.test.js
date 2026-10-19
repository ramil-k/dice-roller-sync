// The account REST over a real socket: Telegram login, roles, games,
// assignments and invites.
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BOT = '123456:TEST-token';
const GM = 100;
let server;
let base;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'drs-acc-routes-'));
  process.env.BOT_TOKEN = BOT;
  process.env.GM_IDS = `${GM}, 101`;
  const { createSyncServer } = await import('../src/server.js');
  server = createSyncServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((res) => server.close(res)));

const signed = (fields) => {
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const key = createHash('sha256').update(BOT).digest();
  return { ...fields, hash: createHmac('sha256', key).update(check).digest('hex') };
};

const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

const login = async (id, first_name) => {
  const { status, body } = await api('POST', '/auth/telegram', {
    body: signed({ id, first_name, auth_date: Math.floor(Date.now() / 1000) }),
  });
  expect(status).toBe(200);
  return body;
};

describe('account routes', () => {
  it('logs in with a signed Telegram payload and refuses a forged one', async () => {
    const gm = await login(GM, 'Мастер');
    expect(gm.user).toMatchObject({ id: GM, name: 'Мастер', role: 'gm' });
    const player = await login(1, 'Аня');
    expect(player.user.role).toBe('player');
    const forged = await api('POST', '/auth/telegram', { body: { ...signed({ id: 1, first_name: 'Аня', auth_date: Math.floor(Date.now() / 1000) }), id: GM } });
    expect(forged.status).toBe(401);
  });

  it('allows the CORS preflight for bearer tokens and DELETE', async () => {
    const res = await fetch(`${base}/me`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toMatch(/Authorization/);
    expect(res.headers.get('access-control-allow-methods')).toMatch(/DELETE/);
  });

  it('requires a session, and the GM role for GM routes', async () => {
    expect((await api('GET', '/me')).status).toBe(401);
    expect((await api('GET', '/me', { token: 'junk' })).status).toBe(401);
    const { token } = await login(1, 'Аня');
    expect((await api('GET', '/users', { token })).status).toBe(403);
    expect((await api('POST', '/assignments', { token, body: { characterId: 'suren', kind: 'campaign', tgId: 1 } })).status).toBe(403);
  });

  it('GM assigns a campaign character; the player sees it, everyone logged in sees who plays', async () => {
    const gm = (await login(GM, 'Мастер')).token;
    const anya = (await login(1, 'Аня')).token;
    const borya = (await login(2, 'Боря')).token;
    const users = await api('GET', '/users', { token: gm });
    expect(users.body.users.map((u) => u.id)).toEqual(expect.arrayContaining([1, 2, GM]));

    const made = await api('POST', '/assignments', { token: gm, body: { characterId: 'suren', kind: 'campaign', tgId: 1 } });
    expect(made.status).toBe(201);
    expect(made.body.assignment).toMatchObject({ characterId: 'suren', kind: 'campaign', stateId: 'suren', player: { id: 1, name: 'Аня' } });

    const all = await api('GET', '/assignments', { token: gm });
    expect(all.body.assignments.map((a) => a.characterId)).toContain('suren');
    expect((await api('GET', '/assignments', { token: anya })).status).toBe(403);

    const me = await api('GET', '/me', { token: anya });
    expect(me.body.assignments.map((a) => a.characterId)).toEqual(['suren']);
    const who = await api('GET', '/characters/suren/assignments', { token: borya });
    expect(who.body.assignments[0].player.name).toBe('Аня');
    expect(who.body.assignments[0].claim).toBeUndefined();
  });

  it('one-shot game: invite link, claim, end the game', async () => {
    const gm = (await login(GM, 'Мастер')).token;
    const borya = (await login(2, 'Боря')).token;
    const { body: { game } } = await api('POST', '/games', { token: gm, body: { title: 'Ночь в Руме', date: '2026-10-25' } });
    const invite = await api('POST', '/assignments', { token: gm, body: { characterId: 'spy-vardan', kind: 'oneshot', gameId: game.id } });
    const code = invite.body.assignment.claim;
    expect(code).toMatch(/^[a-z2-9]{10}$/);

    // unclaimed invites are hidden from players, shown to the GM with the code
    expect((await api('GET', '/characters/spy-vardan/assignments', { token: borya })).body.assignments).toEqual([]);
    expect((await api('GET', '/characters/spy-vardan/assignments', { token: gm })).body.assignments[0].claim).toBe(code);

    const claimed = await api('POST', `/claims/${code}`, { token: borya });
    expect(claimed.body.assignment).toMatchObject({ characterId: 'spy-vardan', kind: 'oneshot', game: { title: 'Ночь в Руме' }, player: { id: 2 } });
    expect((await api('POST', `/claims/${code}`, { token: gm })).status).toBe(404);

    const games = await api('GET', '/games', { token: gm });
    expect(games.body.games.find((g) => g.id === game.id).assignments).toHaveLength(1);

    await api('POST', `/games/${game.id}/end`, { token: gm });
    expect((await api('GET', '/me', { token: borya })).body.assignments.map((a) => a.characterId)).not.toContain('spy-vardan');
  });

  it('GM revokes an assignment', async () => {
    const gm = (await login(GM, 'Мастер')).token;
    const anya = (await login(1, 'Аня')).token;
    const made = await api('POST', '/assignments', { token: gm, body: { characterId: 'yorgos', kind: 'oneshot', tgId: 1 } });
    expect((await api('DELETE', `/assignments/${made.body.assignment.id}`, { token: gm })).status).toBe(200);
    expect((await api('GET', '/me', { token: anya })).body.assignments.map((a) => a.characterId)).not.toContain('yorgos');
  });

  it('validates assignment input', async () => {
    const gm = (await login(GM, 'Мастер')).token;
    const bad = (body) => api('POST', '/assignments', { token: gm, body }).then((r) => r.status);
    expect(await bad({ characterId: '../x', kind: 'campaign' })).toBe(400);
    expect(await bad({ characterId: 'suren', kind: 'forever' })).toBe(400);
    expect(await bad({ characterId: 'suren', kind: 'campaign', tgId: 999 })).toBe(400);
    expect(await bad({ characterId: 'suren', kind: 'oneshot', gameId: 'nope' })).toBe(400);
  });
});
