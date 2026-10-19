// Telegram login and sessions.
//
// The site's <tg-login> opens Telegram's login popup and forwards what it
// returns here (POST /auth/telegram). Telegram signs that payload: `hash` is
// HMAC-SHA256 over the other fields ("key=value" lines, sorted by key, joined
// with \n) keyed with SHA256(bot token) - https://core.telegram.org/widgets/login.
// Only this server knows the bot token, so only it can tell a real login from
// a hand-made profile.
//
// A verified login gets a session token: base64url(JSON { sub, exp }) + "." +
// base64url(HMAC-SHA256(payload, secret)). Stateless - nothing to store, and
// rotating the secret logs everyone out.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

const safeEqual = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// The Telegram user from a widget payload, or null when the signature does
// not match or the login is older than maxAgeSec (a replayed old payload).
export const verifyTelegram = (data, botToken, { maxAgeSec = 86400, now = Date.now() } = {}) => {
  if (!data || typeof data !== 'object' || typeof data.hash !== 'string' || !botToken) return null;
  const check = Object.keys(data)
    .filter((k) => k !== 'hash' && data[k] !== undefined && data[k] !== null)
    .sort()
    .map((k) => `${k}=${data[k]}`)
    .join('\n');
  const secret = createHash('sha256').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(check).digest('hex');
  if (!safeEqual(expected, data.hash)) return null;
  const authDate = Number(data.auth_date);
  if (!Number.isFinite(authDate) || now / 1000 - authDate > maxAgeSec) return null;
  const id = Number(data.id);
  if (!Number.isSafeInteger(id)) return null;
  return {
    id,
    firstName: typeof data.first_name === 'string' ? data.first_name : '',
    lastName: typeof data.last_name === 'string' ? data.last_name : '',
    username: typeof data.username === 'string' ? data.username : '',
    photo: typeof data.photo_url === 'string' ? data.photo_url : '',
  };
};

// Session secret: SESSION_SECRET when set, otherwise derived from the bot
// token so a deploy needs only BOT_TOKEN.
export const sessionSecret = (botToken, explicit) =>
  explicit || (botToken ? createHmac('sha256', 'dice-roller-session').update(botToken).digest('hex') : '');

export const createSession = (tgId, secret, { ttlSec = 30 * 86400, now = Date.now() } = {}) => {
  const payload = b64url(JSON.stringify({ sub: tgId, exp: Math.floor(now / 1000) + ttlSec }));
  return `${payload}.${b64url(createHmac('sha256', secret).update(payload).digest())}`;
};

// { tgId } for a valid, unexpired token, otherwise null.
export const readSession = (token, secret, { now = Date.now() } = {}) => {
  if (typeof token !== 'string' || !secret) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  if (!safeEqual(b64url(createHmac('sha256', secret).update(payload).digest()), sig)) return null;
  try {
    const { sub, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(sub) || !(exp > now / 1000)) return null;
    return { tgId: sub };
  } catch {
    return null;
  }
};
