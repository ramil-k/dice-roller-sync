// dice-roller-sync: Yjs WebSocket sync server for the battle-mat encounter.
//
// REST:  GET  /health                    -> { ok: true }
//        POST /rooms                     -> { code }   (create a room)
//        GET  /rooms                     -> { rooms: [...] } every room with its live
//                                           connection count and player names (the
//                                           battle screen's room list - so the codes
//                                           are visible to anyone who opens the site)
//        GET  /rooms/<code>              -> { exists, ...same fields } / 404
//        POST /rooms/<code>/images       -> { id, path } (body: raw image bytes, Content-Type
//                                           image/png|jpeg|webp|gif, up to MAX_IMAGE_BYTES)
//        GET  /rooms/<code>/images/<id>  -> the image, cacheable forever (content-addressed)
// WS:    /ws/<code>                      -> y-websocket sync protocol (rejects unknown codes)
//
// Persistence: merged Yjs update blobs under DATA_DIR + rooms.json (registry)
// + uploaded images under DATA_DIR/images/<code>/.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { docs, setPersistence, setupWSConnection } from './wsdoc.js';
import { createFilePersistence } from './persistence.js';
import { createRegistry } from './registry.js';
import { createImageStore, IMAGE_TYPES } from './images.js';
import { isValidCode } from './codes.js';

const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.DATA_DIR ?? './data';
const MAX_PAYLOAD = 32 * 1024 * 1024; // older encounter docs still carry data-URI images
// the client downscales to 2048px before uploading; nginx caps bodies at 32m
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES ?? 16 * 1024 * 1024);

const registry = createRegistry(DATA_DIR);
const images = createImageStore(`${DATA_DIR}/images`);

setPersistence(createFilePersistence(`${DATA_DIR}/yjs`));

// The REST API is open to any origin: it carries no credentials and nothing
// sensitive - the room code itself is the secret (and the ws handshake is
// gated by it; browsers do not enforce CORS on WebSocket anyway). An origin
// allowlist here only breaks legitimate mirrors of the site (custom domains,
// LAN dev servers) without protecting anything.
const cors = (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
};

// Live view of a room: how many sockets are on it and who they say they
// are (awareness `user` states - peer-supplied, so clipped to the shape the
// client renders anyway).
const liveRoom = (entry) => {
  const doc = docs.get(entry.code);
  const players = [];
  if (doc) {
    doc.awareness.getStates().forEach((state) => {
      const u = state?.user;
      if (!u || typeof u.name !== 'string') return;
      players.push({
        name: u.name.slice(0, 32),
        color: typeof u.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(u.color) ? u.color : null,
      });
    });
  }
  return { ...entry, connections: doc?.conns.size ?? 0, players };
};

const roomList = () =>
  registry
    .entries()
    .map(liveRoom)
    .sort((a, b) => b.connections - a.connections || (a.lastActiveAt < b.lastActiveAt ? 1 : -1));

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

// Buffer a request body up to `limit` bytes; resolves null when it is larger
// (the socket is dropped - a client past the limit has nothing to wait for).
const readBody = (req, limit) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const imageRoutes = async (req, res, pathname) => {
  const upload = pathname.match(/^\/rooms\/([a-z0-9-]+)\/images$/);
  if (req.method === 'POST' && upload) {
    const room = upload[1];
    if (!registry.has(room)) return json(res, 404, { error: 'unknown room' });
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES[type]) return json(res, 415, { error: 'unsupported image type' });
    const declared = Number(req.headers['content-length']);
    if (declared > MAX_IMAGE_BYTES) return json(res, 413, { error: 'image too large' });
    const buf = await readBody(req, MAX_IMAGE_BYTES);
    if (buf === null) return json(res, 413, { error: 'image too large' });
    if (buf.length === 0) return json(res, 400, { error: 'empty body' });
    const id = images.put(room, buf, type);
    return json(res, 201, { id, path: `/rooms/${room}/images/${id}` });
  }
  const serve = pathname.match(/^\/rooms\/([a-z0-9-]+)\/images\/([a-z0-9.]+)$/);
  if (req.method === 'GET' && serve) {
    const img = registry.has(serve[1]) ? images.get(serve[1], serve[2]) : null;
    if (!img) return json(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': img.type,
      'Content-Length': img.buf.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    return res.end(img.buf);
  }
  return false;
};

export const createSyncServer = () => {
  const server = createServer(async (req, res) => {
    cors(req, res);
    const { pathname } = new URL(req.url, 'http://x');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    if (req.method === 'GET' && pathname === '/health') {
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && pathname === '/rooms') {
      return json(res, 201, { code: registry.create() });
    }
    if (req.method === 'GET' && pathname === '/rooms') {
      return json(res, 200, { rooms: roomList() });
    }
    const roomMatch = pathname.match(/^\/rooms\/([a-z0-9-]+)$/);
    if (req.method === 'GET' && roomMatch) {
      const entry = registry.entries().find((r) => r.code === roomMatch[1]);
      if (!entry) return json(res, 404, { exists: false });
      return json(res, 200, { exists: true, ...liveRoom(entry) });
    }
    try {
      if ((await imageRoutes(req, res, pathname)) !== false) return;
    } catch (err) {
      console.error('image route failed', err);
      return json(res, 500, { error: 'image store failed' });
    }
    return json(res, 404, { error: 'not found' });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  wss.on('connection', (conn, _req, room) => setupWSConnection(conn, room));

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://x');
    const match = pathname.match(/^\/ws\/([a-z0-9-]+)$/);
    const room = match?.[1];
    if (!room || !isValidCode(room) || !registry.has(room)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      return socket.destroy();
    }
    registry.touch(room);
    wss.handleUpgrade(req, socket, head, (conn) => {
      wss.emit('connection', conn, req, room);
    });
  });

  return server;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createSyncServer().listen(PORT, () => {
    console.log(`dice-roller-sync listening on :${PORT}, data in ${DATA_DIR}`);
  });
}
