// Room registry: which room codes exist. A JSON file next to the leveldb
// data; joining an unknown code is rejected (typo protection), so rooms are
// born only through POST /rooms.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newCode } from './codes.js';

export const createRegistry = (dataDir) => {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'rooms.json');
  let rooms = {};
  try {
    rooms = JSON.parse(readFileSync(file, 'utf8')).rooms ?? {};
  } catch {
    // first run or unreadable file - start empty
  }

  const persist = () => {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ rooms }, null, '\t'));
    renameSync(tmp, file); // atomic on POSIX
  };

  return {
    has: (code) => Object.hasOwn(rooms, code),
    create: () => {
      let code;
      do {
        code = newCode();
      } while (Object.hasOwn(rooms, code));
      rooms[code] = { createdAt: new Date().toISOString() };
      persist();
      return code;
    },
    // A client connected to the room - remember when it was last used, so
    // the room list can be sorted by recency (and stale rooms spotted).
    touch: (code) => {
      if (!Object.hasOwn(rooms, code)) return;
      rooms[code].lastActiveAt = new Date().toISOString();
      persist();
    },
    list: () => Object.keys(rooms),
    // [{ code, createdAt, lastActiveAt }] - lastActiveAt falls back to createdAt
    entries: () =>
      Object.entries(rooms).map(([code, r]) => ({
        code,
        createdAt: r.createdAt,
        lastActiveAt: r.lastActiveAt ?? r.createdAt,
      })),
  };
};
