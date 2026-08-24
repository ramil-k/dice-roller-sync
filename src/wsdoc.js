// Server side of the y-websocket sync protocol, adapted from the reference
// y-websocket server (MIT, (c) Kevin Jahns and contributors). Vendored so the
// whole process runs on a single stable yjs@13 instance - the published
// server packages currently depend on yjs v14 pre-releases, which cannot
// exchange documents with the v13-based clients and y-leveldb.
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const PING_TIMEOUT = 30000;
const WS_OPEN = 1;

/** @type {Map<string, WSSharedDoc>} live docs by room code */
export const docs = new Map();

// { bindState(name, ydoc): Promise, writeState(name, ydoc): Promise } | null
let persistence = null;
export const setPersistence = (p) => {
  persistence = p;
};

const send = (doc, conn, message) => {
  if (conn.readyState !== undefined && conn.readyState > WS_OPEN) {
    return closeConn(doc, conn);
  }
  try {
    conn.send(message, (err) => err && closeConn(doc, conn));
  } catch {
    closeConn(doc, conn);
  }
};

const broadcast = (doc, message) => {
  doc.conns.forEach((_, conn) => send(doc, conn, message));
};

class WSSharedDoc extends Y.Doc {
  constructor(name) {
    super({ gc: true });
    this.name = name;
    /** @type {Map<import('ws').WebSocket, Set<number>>} conn -> awareness client ids */
    this.conns = new Map();
    this.awareness = new awarenessProtocol.Awareness(this);
    this.awareness.setLocalState(null);

    this.awareness.on('update', ({ added, updated, removed }, conn) => {
      const changed = added.concat(updated, removed);
      if (conn !== null) {
        const owned = this.conns.get(conn);
        if (owned) {
          added.forEach((id) => owned.add(id));
          removed.forEach((id) => owned.delete(id));
        }
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
      );
      broadcast(this, encoding.toUint8Array(encoder));
    });

    this.on('update', (update) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      broadcast(this, encoding.toUint8Array(encoder));
    });
  }
}

const getYDoc = (name) => {
  let doc = docs.get(name);
  if (!doc) {
    doc = new WSSharedDoc(name);
    docs.set(name, doc);
    if (persistence) {
      doc.whenBound = persistence.bindState(name, doc);
    }
  }
  return doc;
};

const closeConn = (doc, conn) => {
  const owned = doc.conns.get(conn);
  if (owned) {
    doc.conns.delete(conn);
    awarenessProtocol.removeAwarenessStates(doc.awareness, [...owned], null);
    if (doc.conns.size === 0) {
      const finish = () => {
        doc.destroy();
        docs.delete(doc.name);
      };
      if (persistence) {
        Promise.resolve(persistence.writeState(doc.name, doc)).then(finish, finish);
      } else {
        finish();
      }
    }
  }
  try {
    conn.close();
  } catch {
    // already gone
  }
};

const messageListener = (conn, doc, message) => {
  try {
    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);
    if (messageType === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, doc, conn);
      if (encoding.length(encoder) > 1) {
        send(doc, conn, encoding.toUint8Array(encoder));
      }
    } else if (messageType === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        doc.awareness,
        decoding.readVarUint8Array(decoder),
        conn,
      );
    }
  } catch (err) {
    console.error('failed to handle message', err);
  }
};

export const setupWSConnection = (conn, docName) => {
  conn.binaryType = 'arraybuffer';
  const doc = getYDoc(docName);
  doc.conns.set(conn, new Set());

  conn.on('message', (message) => messageListener(conn, doc, new Uint8Array(message)));

  let pongReceived = true;
  const pingInterval = setInterval(() => {
    if (!pongReceived) {
      if (doc.conns.has(conn)) closeConn(doc, conn);
      return clearInterval(pingInterval);
    }
    if (doc.conns.has(conn)) {
      pongReceived = false;
      try {
        conn.ping();
      } catch {
        closeConn(doc, conn);
        clearInterval(pingInterval);
      }
    }
  }, PING_TIMEOUT);
  conn.on('pong', () => {
    pongReceived = true;
  });
  conn.on('close', () => {
    closeConn(doc, conn);
    clearInterval(pingInterval);
  });

  // The initial handshake waits for persisted state, so a late joiner's
  // first sync already carries the room's history.
  const start = () => {
    if (!doc.conns.has(conn)) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, doc);
    send(doc, conn, encoding.toUint8Array(encoder));
    const states = doc.awareness.getStates();
    if (states.size > 0) {
      const awarenessEncoder = encoding.createEncoder();
      encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        awarenessEncoder,
        awarenessProtocol.encodeAwarenessUpdate(doc.awareness, [...states.keys()]),
      );
      send(doc, conn, encoding.toUint8Array(awarenessEncoder));
    }
  };
  Promise.resolve(doc.whenBound).then(start, start);
};
