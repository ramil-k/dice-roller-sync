// File-backed persistence: one merged Yjs update blob per room under
// data/yjs/<code>.yupdate. Writes are debounced while clients are connected
// and flushed when the last one leaves. Pure JS - no native leveldb, and no
// second yjs instance sneaking in through a CJS dependency.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Y from 'yjs';

export const createFilePersistence = (dir, { debounceMs = 800 } = {}) => {
  mkdirSync(dir, { recursive: true });
  const fileOf = (name) => join(dir, `${name}.yupdate`);
  const timers = new Map();

  const write = (name, doc) => {
    const tmp = `${fileOf(name)}.tmp`;
    writeFileSync(tmp, Y.encodeStateAsUpdate(doc));
    renameSync(tmp, fileOf(name)); // atomic on POSIX
  };

  return {
    bindState: async (name, doc) => {
      try {
        Y.applyUpdate(doc, new Uint8Array(readFileSync(fileOf(name))));
      } catch {
        // no state yet - fresh room
      }
      doc.on('update', () => {
        clearTimeout(timers.get(name));
        timers.set(name, setTimeout(() => write(name, doc), debounceMs));
      });
    },
    writeState: async (name, doc) => {
      clearTimeout(timers.get(name));
      timers.delete(name);
      write(name, doc);
    },
  };
};
