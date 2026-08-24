// dice-roller-sync: Yjs WebSocket sync server for the battle-mat encounter.
//
// REST:  GET  /health         -> { ok: true }
//        POST /rooms          -> { code }   (create a room; the code is the secret)
//        GET  /rooms/<code>   -> { exists } (client-side validation before joining)
// WS:    /ws/<code>           -> y-websocket sync protocol (rejects unknown codes)
//
// Persistence: merged Yjs update blobs under DATA_DIR + rooms.json (registry).
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { setPersistence, setupWSConnection } from './wsdoc.js';
import { createFilePersistence } from './persistence.js';
import { createRegistry } from './registry.js';
import { isValidCode } from './codes.js';

const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.DATA_DIR ?? './data';
const MAX_PAYLOAD = 32 * 1024 * 1024; // encounter docs carry data-URI images

// Origins allowed to call the REST API (the ws handshake is gated by the
// room code instead - browsers do not enforce CORS on WebSocket anyway).
const ORIGIN_ALLOW = [
  /^https:\/\/ramil-k\.github\.io$/,
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
];

const registry = createRegistry(DATA_DIR);

setPersistence(createFilePersistence(`${DATA_DIR}/yjs`));

const cors = (req, res) => {
  const origin = req.headers.origin;
  if (origin && ORIGIN_ALLOW.some((re) => re.test(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
};

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

export const createSyncServer = () => {
  const server = createServer((req, res) => {
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
    const roomMatch = pathname.match(/^\/rooms\/([a-z0-9-]+)$/);
    if (req.method === 'GET' && roomMatch) {
      return json(res, registry.has(roomMatch[1]) ? 200 : 404, {
        exists: registry.has(roomMatch[1]),
      });
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
