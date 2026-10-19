// REST for players and characters (see accounts.js for the model).
//
//   POST   /auth/telegram              body: the Telegram widget payload
//                                      -> { token, user } (401 bad signature,
//                                         503 when BOT_TOKEN is not configured)
//   GET    /me                         -> { user, assignments }       [player]
//   POST   /claims/<code>              take an invite -> { assignment } [player]
//   GET    /characters/<id>/assignments who plays it   -> { assignments } [player]
//   GET    /users                      everyone who logged in -> { users } [gm]
//   GET    /games                      -> { games } with their assignments [gm]
//   POST   /games                      body { title, date? } -> { game }   [gm]
//   POST   /games/<id>/end             end it and all its loans -> { game } [gm]
//   GET    /assignments                every active assignment -> { assignments } [gm]
//   POST   /assignments                body { characterId, kind, tgId?, gameId?,
//                                      endsAt? } -> { assignment }; without
//                                      tgId it is an invite with a claim code [gm]
//   DELETE /assignments/<id>           revoke -> { assignment }        [gm]
//
// [player] = any valid session (Authorization: Bearer <token>), [gm] = a
// session whose Telegram id is in GM_IDS. Invite codes are shown to the GM only.
import { createSession, readSession, verifyTelegram } from './auth.js';
import { isCharacterId, KINDS } from './accounts.js';
import { json, readJson } from './http.js';

export const createAccountRoutes = ({ accounts, botToken, secret, gmIds }) => {
  const roleOf = (tgId) => (gmIds.has(tgId) ? 'gm' : 'player');

  const publicUser = (u) => (u ? { id: u.id, name: u.name, username: u.username, photo: u.photo } : null);

  const view = (a, { gm = false } = {}) => {
    const game = a.gameId ? accounts.game(a.gameId) : null;
    return {
      id: a.id,
      characterId: a.characterId,
      kind: a.kind,
      stateId: a.stateId,
      createdAt: a.createdAt,
      endsAt: a.endsAt,
      game: game ? { id: game.id, title: game.title, date: game.date, endedAt: game.endedAt } : null,
      player: publicUser(a.tgId === null ? null : accounts.user(a.tgId)),
      ...(gm ? { claim: a.tgId === null ? a.claim : null, active: accounts.isActive(a) } : {}),
    };
  };

  const session = (req) => {
    const header = req.headers.authorization ?? '';
    const s = readSession(header.startsWith('Bearer ') ? header.slice(7) : '', secret);
    return s && accounts.user(s.tgId) ? s : null;
  };

  return async (req, res, pathname) => {
    if (req.method === 'POST' && pathname === '/auth/telegram') {
      if (!botToken) return json(res, 503, { error: 'login is not configured' });
      const tgUser = verifyTelegram(await readJson(req), botToken);
      if (!tgUser) return json(res, 401, { error: 'bad telegram signature' });
      const user = accounts.upsertUser(tgUser);
      return json(res, 200, {
        token: createSession(user.id, secret),
        user: { ...publicUser(user), role: roleOf(user.id) },
      });
    }

    const isAccountPath =
      pathname === '/me' ||
      pathname === '/users' ||
      pathname.startsWith('/games') ||
      pathname.startsWith('/assignments') ||
      pathname.startsWith('/claims/') ||
      /^\/characters\/[^/]+\/assignments$/.test(pathname);
    if (!isAccountPath) return false;

    const s = session(req);
    if (!s) return json(res, 401, { error: 'login required' });
    const gm = roleOf(s.tgId) === 'gm';

    if (req.method === 'GET' && pathname === '/me') {
      return json(res, 200, {
        user: { ...publicUser(accounts.user(s.tgId)), role: roleOf(s.tgId) },
        assignments: accounts.forUser(s.tgId).map((a) => view(a)),
      });
    }

    const claimMatch = pathname.match(/^\/claims\/([a-z0-9]+)$/);
    if (req.method === 'POST' && claimMatch) {
      const a = accounts.claim(claimMatch[1], s.tgId);
      if (!a) return json(res, 404, { error: 'invite is unknown, taken or expired' });
      return json(res, 200, { assignment: view(a) });
    }

    const charMatch = pathname.match(/^\/characters\/([^/]+)\/assignments$/);
    if (req.method === 'GET' && charMatch) {
      if (!isCharacterId(charMatch[1])) return json(res, 400, { error: 'bad character id' });
      const list = accounts.forCharacter(charMatch[1]).filter((a) => gm || a.tgId !== null);
      return json(res, 200, { assignments: list.map((a) => view(a, { gm })) });
    }

    if (!gm) return json(res, 403, { error: 'game master only' });

    if (req.method === 'GET' && pathname === '/users') {
      return json(res, 200, { users: accounts.users().map((u) => ({ ...publicUser(u), role: roleOf(u.id), lastSeen: u.lastSeen })) });
    }
    if (req.method === 'GET' && pathname === '/games') {
      return json(res, 200, {
        games: accounts.games().map((g) => ({ ...g, assignments: accounts.forGame(g.id).map((a) => view(a, { gm })) })),
      });
    }
    if (req.method === 'POST' && pathname === '/games') {
      const body = await readJson(req);
      const title = typeof body?.title === 'string' ? body.title.trim() : '';
      if (!title) return json(res, 400, { error: 'title required' });
      const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : null;
      return json(res, 201, { game: accounts.createGame({ title, date }) });
    }
    const endMatch = pathname.match(/^\/games\/([A-Za-z0-9_-]+)\/end$/);
    if (req.method === 'POST' && endMatch) {
      const game = accounts.endGame(endMatch[1]);
      return game ? json(res, 200, { game }) : json(res, 404, { error: 'unknown game' });
    }
    if (req.method === 'GET' && pathname === '/assignments') {
      return json(res, 200, { assignments: accounts.active().map((a) => view(a, { gm })) });
    }
    if (req.method === 'POST' && pathname === '/assignments') {
      const body = await readJson(req);
      if (!body || !isCharacterId(body.characterId)) return json(res, 400, { error: 'bad character id' });
      if (!KINDS.includes(body.kind)) return json(res, 400, { error: 'kind must be campaign or oneshot' });
      const tgId = body.tgId ?? null;
      if (tgId !== null && !accounts.user(tgId)) return json(res, 400, { error: 'unknown player' });
      const gameId = body.gameId ?? null;
      if (gameId !== null && !accounts.game(gameId)) return json(res, 400, { error: 'unknown game' });
      if (body.kind === 'campaign' && gameId !== null) return json(res, 400, { error: 'campaign characters do not belong to a game' });
      const endsAt = typeof body.endsAt === 'string' && !Number.isNaN(Date.parse(body.endsAt)) ? new Date(body.endsAt).toISOString() : null;
      const a = accounts.assign({ characterId: body.characterId, tgId, kind: body.kind, gameId, endsAt });
      return json(res, 201, { assignment: view(a, { gm }) });
    }
    const revokeMatch = pathname.match(/^\/assignments\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'DELETE' && revokeMatch) {
      const a = accounts.revoke(revokeMatch[1]);
      return a ? json(res, 200, { assignment: view(a, { gm }) }) : json(res, 404, { error: 'unknown assignment' });
    }
    return json(res, 404, { error: 'not found' });
  };
};
