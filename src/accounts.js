// Players, games and who plays which character. One JSON file
// (DATA_DIR/accounts.json), rewritten atomically like rooms.json.
//
// users        tgId -> { id, name, username, photo, firstSeen, lastSeen }
//              everyone who ever logged in (the GM picks players from here)
// games        id -> { id, title, date, createdAt, endedAt }
//              a one-shot or a session; ending it ends all of its assignments
// assignments  id -> { id, characterId, tgId, kind, gameId, stateId, claim,
//                      createdAt, claimedAt, endsAt, revokedAt }
//   kind "campaign": the character's standing owner - one active per
//     character, its state (stateId = characterId) carries over between games;
//   kind "oneshot": a loan for one game - its own fresh state
//     (stateId = "<characterId>--<id>"), many at once (the same pregen in
//     two games), gone when revoked, past endsAt or when its game ends.
//   tgId null + claim code: an invite - the first player to open the link
//     takes it (claim()).
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const KINDS = ['campaign', 'oneshot'];
export const isCharacterId = (id) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);

const newId = () => randomBytes(6).toString('base64url');
// invite codes travel in URLs and get read aloud - lowercase, no look-alikes
const CLAIM_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const newClaim = () => Array.from(randomBytes(10), (b) => CLAIM_ALPHABET[b % CLAIM_ALPHABET.length]).join('');

export const createAccounts = (dataDir, { now = () => Date.now() } = {}) => {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'accounts.json');
  let data = { users: {}, games: {}, assignments: {} };
  try {
    data = { ...data, ...JSON.parse(readFileSync(file, 'utf8')) };
  } catch {
    // first run or unreadable file - start empty
  }

  const persist = () => {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, '\t'));
    renameSync(tmp, file);
  };
  const iso = () => new Date(now()).toISOString();

  const isActive = (a) =>
    !a.revokedAt &&
    !(a.endsAt && Date.parse(a.endsAt) <= now()) &&
    !(a.gameId && data.games[a.gameId]?.endedAt);

  const activeAssignments = () => Object.values(data.assignments).filter(isActive);

  return {
    upsertUser(u) {
      const prev = data.users[u.id];
      data.users[u.id] = {
        id: u.id,
        name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || String(u.id),
        username: u.username ?? '',
        photo: u.photo ?? '',
        firstSeen: prev?.firstSeen ?? iso(),
        lastSeen: iso(),
      };
      persist();
      return data.users[u.id];
    },
    user: (tgId) => data.users[tgId] ?? null,
    users: () => Object.values(data.users).sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1)),

    createGame({ title, date = null }) {
      const id = newId();
      data.games[id] = { id, title: String(title).slice(0, 80), date, createdAt: iso(), endedAt: null };
      persist();
      return data.games[id];
    },
    endGame(id) {
      const game = data.games[id];
      if (!game) return null;
      game.endedAt ??= iso();
      persist();
      return game;
    },
    game: (id) => data.games[id] ?? null,
    games: () => Object.values(data.games).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),

    // tgId null makes an invite (claim code). A new campaign assignment
    // replaces the character's previous campaign one.
    assign({ characterId, tgId = null, kind, gameId = null, endsAt = null }) {
      const id = newId();
      if (kind === 'campaign') {
        for (const a of activeAssignments()) {
          if (a.characterId === characterId && a.kind === 'campaign') a.revokedAt = iso();
        }
      }
      data.assignments[id] = {
        id,
        characterId,
        tgId,
        kind,
        gameId,
        stateId: kind === 'campaign' ? characterId : `${characterId}--${id}`,
        claim: tgId === null ? newClaim() : null,
        createdAt: iso(),
        claimedAt: tgId === null ? null : iso(),
        endsAt,
        revokedAt: null,
      };
      persist();
      return data.assignments[id];
    },
    // The invite with this code goes to tgId; null when it is unknown, taken
    // or no longer active.
    claim(code, tgId) {
      const a = Object.values(data.assignments).find((x) => x.claim === code);
      if (!a || a.tgId !== null || !isActive(a)) return null;
      a.tgId = tgId;
      a.claimedAt = iso();
      persist();
      return a;
    },
    revoke(id) {
      const a = data.assignments[id];
      if (!a) return null;
      a.revokedAt ??= iso();
      persist();
      return a;
    },
    assignment: (id) => data.assignments[id] ?? null,
    isActive,
    active: activeAssignments,
    forUser: (tgId) => activeAssignments().filter((a) => a.tgId === tgId),
    forCharacter: (characterId) => activeAssignments().filter((a) => a.characterId === characterId),
    forGame: (gameId) => Object.values(data.assignments).filter((a) => a.gameId === gameId && !a.revokedAt),
  };
};
