// Room image store: attached map images are uploaded here and referenced by
// URL from the encounter, instead of riding inside the Yjs document as
// multi-megabyte data URIs (which every peer would receive on every connect
// and every device would have to fit into localStorage). Files live under
// data/images/<code>/<sha256[:24]>.<ext> - content-addressed, so re-uploads
// of the same picture dedupe and an id can be cached forever.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const IMAGE_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const EXT_TYPES = Object.fromEntries(Object.entries(IMAGE_TYPES).map(([t, e]) => [e, t]));
const ID_RE = /^([a-f0-9]{24})\.(png|jpg|webp|gif)$/;

export const isValidImageId = (id) => ID_RE.test(id);

export const createImageStore = (dir) => {
  mkdirSync(dir, { recursive: true });
  return {
    // Store `buf` of MIME `type` for `room`; returns the image id.
    put: (room, buf, type) => {
      const ext = IMAGE_TYPES[type];
      if (!ext) throw new Error('unsupported image type');
      const id = `${createHash('sha256').update(buf).digest('hex').slice(0, 24)}.${ext}`;
      const roomDir = join(dir, room);
      mkdirSync(roomDir, { recursive: true });
      const file = join(roomDir, id);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, buf);
      renameSync(tmp, file); // atomic on POSIX; a duplicate simply overwrites itself
      return id;
    },
    // { buf, type } or null when the room has no such image.
    get: (room, id) => {
      const m = ID_RE.exec(id);
      if (!m) return null;
      try {
        return { buf: readFileSync(join(dir, room, id)), type: EXT_TYPES[m[2]] };
      } catch {
        return null;
      }
    },
  };
};
