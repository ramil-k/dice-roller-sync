// Room event log: an append-only journal of what happened in a fight, next
// to the Yjs snapshot that only ever holds the *current* state (the doc runs
// with gc, removed tokens and earlier hit points are gone for good). Clients
// post what they did - rolls, hits, initiative, turns, tokens coming and
// going - and the whole journal can be read back later as JSON or as plain
// text to be turned into a story.
//
// Storage: data/events/<code>.ndjson, one JSON event per line. A batch goes
// out as a single appendFileSync call (one write(2) on an O_APPEND
// descriptor), so concurrent batches never interleave and a crash can at
// worst truncate the last line - the reader skips an unparsable tail. No
// database, nothing is ever rewritten or deleted.
//
// Event shape (the server assigns `seq` and `t`; everything else is the
// client's):
//   { seq, t, by: { name, color } | null, type, data }
// Types and their `data` are listed in EVENT_TYPES; unknown types are
// rejected so the text export always knows what it is printing.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_EVENT_BYTES = 4 * 1024; // one serialized event
export const MAX_BATCH_EVENTS = 200;
export const MAX_BATCH_BYTES = 256 * 1024; // the request body
export const MAX_NAME = 64;

// type -> the `data` fields the text export prints (validation only checks
// that `data` is an object, so a client may carry extra fields along)
export const EVENT_TYPES = {
  roll: ['formula', 'total', 'faces', 'label', 'crit'],
  hp: ['nodeId', 'name', 'from', 'to'],
  initiative: ['nodeId', 'name', 'value'],
  turn: ['round', 'activeNodeId', 'activeName'],
  'token-add': ['nodeId', 'name', 'kind', 'hp', 'hpMax'],
  'token-remove': ['nodeId', 'name'],
  rename: ['nodeId', 'from', 'to'],
  'combat-reset': [],
};

const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);

// Normalize one client event into what gets stored, or return { error }.
export const validateEvent = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'event is not an object' };
  if (!Object.hasOwn(EVENT_TYPES, raw.type)) return { error: `unknown event type ${JSON.stringify(raw.type)}` };
  if (raw.data !== undefined && (typeof raw.data !== 'object' || raw.data === null || Array.isArray(raw.data))) {
    return { error: 'data is not an object' };
  }
  let by = null;
  if (raw.by != null) {
    if (typeof raw.by !== 'object' || Array.isArray(raw.by)) return { error: 'by is not an object' };
    const name = str(raw.by.name, MAX_NAME);
    if (name === null) return { error: 'by.name is not a string' };
    by = { name, color: typeof raw.by.color === 'string' && COLOR_RE.test(raw.by.color) ? raw.by.color : null };
  }
  const event = { type: raw.type, by, data: raw.data ?? {} };
  if (Buffer.byteLength(JSON.stringify(event)) > MAX_EVENT_BYTES) return { error: 'event too large' };
  return { event };
};

// Validate a whole POST body: `{ events: [...] }` or a bare array. Returns
// { events } (normalized, in order) or { error }.
export const validateBatch = (body) => {
  const list = Array.isArray(body) ? body : body?.events;
  if (!Array.isArray(list)) return { error: 'events is not an array' };
  if (list.length === 0) return { error: 'empty batch' };
  if (list.length > MAX_BATCH_EVENTS) return { error: `more than ${MAX_BATCH_EVENTS} events` };
  const events = [];
  for (const [i, raw] of list.entries()) {
    const res = validateEvent(raw);
    if (res.error) return { error: `events[${i}]: ${res.error}` };
    events.push(res.event);
  }
  return { events };
};

const parseLines = (text) => {
  const out = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      const ev = JSON.parse(line);
      if (Number.isSafeInteger(ev?.seq)) out.push(ev);
    } catch {
      // a truncated tail (crash mid-write) - nothing after it anyway
    }
  }
  return out;
};

export const createEventStore = (dir) => {
  mkdirSync(dir, { recursive: true });
  const fileOf = (room) => join(dir, `${room}.ndjson`);
  const lastSeq = new Map(); // room -> last assigned seq (loaded lazily)

  const readAll = (room) => {
    try {
      return parseLines(readFileSync(fileOf(room), 'utf8'));
    } catch {
      return []; // no journal yet
    }
  };

  const seqOf = (room) => {
    if (!lastSeq.has(room)) {
      const all = readAll(room);
      lastSeq.set(room, all.length ? all[all.length - 1].seq : 0);
    }
    return lastSeq.get(room);
  };

  return {
    // Append validated events (see validateBatch) in order; returns the
    // stored events, seq and t filled in.
    append: (room, events, { now = () => new Date() } = {}) => {
      let seq = seqOf(room);
      const t = now().toISOString();
      const stored = events.map((ev) => ({ seq: ++seq, t, by: ev.by, type: ev.type, data: ev.data }));
      appendFileSync(fileOf(room), stored.map((ev) => `${JSON.stringify(ev)}\n`).join(''));
      lastSeq.set(room, seq);
      return stored;
    },
    // Every event with seq > since, oldest first.
    read: (room, { since = 0 } = {}) => readAll(room).filter((ev) => ev.seq > since),
    lastSeq: seqOf,
  };
};

// ---------------------------------------------------------------------------
// text export: one line per event, chronological, for feeding to a chat

const who = (ev) => (ev.by?.name ? ev.by.name : 'someone');
const q = (s) => (s == null || s === '' ? '?' : String(s));

const LINE = {
  roll: (d, ev) => {
    const faces = Array.isArray(d.faces) && d.faces.length ? ` [${d.faces.join(', ')}]` : '';
    const label = d.label ? ` for ${d.label}` : '';
    const crit = d.crit === 'success' ? ' - natural 20!' : d.crit === 'failure' ? ' - natural 1!' : '';
    return `${who(ev)} rolls ${q(d.formula)}${label}: ${q(d.total)}${faces}${crit}`;
  },
  hp: (d, ev) => {
    const delta = Number.isFinite(d.from) && Number.isFinite(d.to) ? d.to - d.from : null;
    const verb = delta === null ? 'HP' : delta < 0 ? `takes ${-delta} damage` : `heals ${delta}`;
    const tail = Number.isFinite(d.to) && d.to <= 0 ? ', down' : '';
    return `${q(d.name)} ${verb} (HP ${q(d.from)} -> ${q(d.to)})${tail} - by ${who(ev)}`;
  },
  initiative: (d, ev) => `${q(d.name)} initiative ${q(d.value)} - by ${who(ev)}`,
  turn: (d, ev) => `round ${q(d.round)}: ${q(d.activeName)}'s turn - by ${who(ev)}`,
  'token-add': (d, ev) => {
    const hp = Number.isFinite(d.hp) ? ` (HP ${d.hp}${Number.isFinite(d.hpMax) && d.hpMax !== d.hp ? `/${d.hpMax}` : ''})` : '';
    return `${who(ev)} adds ${d.kind === 'monster' ? 'monster' : 'player'} ${q(d.name)}${hp}`;
  },
  'token-remove': (d, ev) => `${who(ev)} removes ${q(d.name)}`,
  rename: (d, ev) => `${who(ev)} renames ${q(d.from)} to ${q(d.to)}`,
  'combat-reset': (_d, ev) => `${who(ev)} resets the combat`,
};

export const formatEventLine = (ev) => {
  const body = LINE[ev.type]?.(ev.data ?? {}, ev) ?? `${who(ev)} ${ev.type} ${JSON.stringify(ev.data ?? {})}`;
  return `#${ev.seq} ${ev.t} ${ev.type}: ${body}`;
};

export const formatEventsText = (events) => events.map(formatEventLine).join('\n') + (events.length ? '\n' : '');
