import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSession, readSession, sessionSecret, verifyTelegram } from '../src/auth.js';

const BOT = '123456:TEST-token';
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);

// Sign the way Telegram does (https://core.telegram.org/widgets/login).
const signed = (fields) => {
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const key = createHash('sha256').update(BOT).digest();
  return { ...fields, hash: createHmac('sha256', key).update(check).digest('hex') };
};

const login = { id: 42, first_name: 'Рамиль', username: 'ramil', photo_url: 'https://t.me/i/u.jpg', auth_date: Math.floor(NOW / 1000) - 60 };

describe('verifyTelegram', () => {
  it('accepts a payload signed with the bot token', () => {
    expect(verifyTelegram(signed(login), BOT, { now: NOW })).toEqual({
      id: 42, firstName: 'Рамиль', lastName: '', username: 'ramil', photo: 'https://t.me/i/u.jpg',
    });
  });

  it('rejects a tampered field', () => {
    expect(verifyTelegram({ ...signed(login), id: 43 }, BOT, { now: NOW })).toBe(null);
  });

  it('rejects another bot token', () => {
    expect(verifyTelegram(signed(login), '999:other', { now: NOW })).toBe(null);
  });

  it('rejects a stale login', () => {
    expect(verifyTelegram(signed({ ...login, auth_date: Math.floor(NOW / 1000) - 2 * 86400 }), BOT, { now: NOW })).toBe(null);
  });

  it('rejects junk', () => {
    expect(verifyTelegram(null, BOT)).toBe(null);
    expect(verifyTelegram({ id: 1 }, BOT)).toBe(null);
    expect(verifyTelegram(signed(login), '', { now: NOW })).toBe(null);
  });
});

describe('sessions', () => {
  const secret = sessionSecret(BOT);

  it('round-trips the Telegram id', () => {
    expect(readSession(createSession(42, secret, { now: NOW }), secret, { now: NOW })).toEqual({ tgId: 42 });
  });

  it('expires', () => {
    const token = createSession(42, secret, { now: NOW, ttlSec: 60 });
    expect(readSession(token, secret, { now: NOW + 61_000 })).toBe(null);
  });

  it('rejects a forged payload or another secret', () => {
    const token = createSession(42, secret, { now: NOW });
    const [, sig] = token.split('.');
    const forged = `${Buffer.from(JSON.stringify({ sub: 1, exp: 9e9 })).toString('base64url')}.${sig}`;
    expect(readSession(forged, secret, { now: NOW })).toBe(null);
    expect(readSession(token, sessionSecret('other'), { now: NOW })).toBe(null);
    expect(readSession('garbage', secret)).toBe(null);
  });

  it('prefers an explicit secret and has none without a bot token', () => {
    expect(sessionSecret(BOT, 'explicit')).toBe('explicit');
    expect(sessionSecret('', undefined)).toBe('');
  });
});
