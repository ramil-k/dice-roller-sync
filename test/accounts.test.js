import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAccounts, isCharacterId } from '../src/accounts.js';

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'drs-acc-'));
  let t = Date.UTC(2026, 9, 19);
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const accounts = createAccounts(dir, { now: clock.now });
  accounts.upsertUser({ id: 1, firstName: 'Аня' });
  accounts.upsertUser({ id: 2, firstName: 'Боря', username: 'borya' });
  return { dir, clock, accounts };
};

describe('accounts', () => {
  it('validates character ids', () => {
    expect(isCharacterId('spy-vardan')).toBe(true);
    expect(isCharacterId('../etc')).toBe(false);
    expect(isCharacterId('')).toBe(false);
  });

  it('keeps one campaign owner per character', () => {
    const { accounts } = setup();
    accounts.assign({ characterId: 'suren', tgId: 1, kind: 'campaign' });
    accounts.assign({ characterId: 'suren', tgId: 2, kind: 'campaign' });
    expect(accounts.forCharacter('suren').map((a) => a.tgId)).toEqual([2]);
    expect(accounts.forUser(1)).toEqual([]);
    expect(accounts.forUser(2)[0].stateId).toBe('suren');
  });

  it('lends the same pregen to several one-shots, each with its own state', () => {
    const { accounts } = setup();
    const g1 = accounts.createGame({ title: 'Ночь в Руме' });
    const g2 = accounts.createGame({ title: 'Перевал' });
    const a = accounts.assign({ characterId: 'spy-vardan', tgId: 1, kind: 'oneshot', gameId: g1.id });
    const b = accounts.assign({ characterId: 'spy-vardan', tgId: 2, kind: 'oneshot', gameId: g2.id });
    expect(a.stateId).not.toBe(b.stateId);
    expect(a.stateId.startsWith('spy-vardan--')).toBe(true);
    expect(accounts.forCharacter('spy-vardan')).toHaveLength(2);
  });

  it('ending a game ends its loans; revoke and endsAt end one', () => {
    const { accounts, clock } = setup();
    const game = accounts.createGame({ title: 'Ваншот' });
    accounts.assign({ characterId: 'yorgos', tgId: 1, kind: 'oneshot', gameId: game.id });
    const timed = accounts.assign({ characterId: 'sherin', tgId: 1, kind: 'oneshot', endsAt: new Date(clock.now() + 3600e3).toISOString() });
    const revoked = accounts.assign({ characterId: 'suren', tgId: 1, kind: 'campaign' });
    expect(accounts.forUser(1)).toHaveLength(3);
    accounts.endGame(game.id);
    accounts.revoke(revoked.id);
    expect(accounts.forUser(1).map((a) => a.id)).toEqual([timed.id]);
    clock.advance(3600e3);
    expect(accounts.forUser(1)).toEqual([]);
  });

  it('invites are claimed once', () => {
    const { accounts } = setup();
    const invite = accounts.assign({ characterId: 'puup', kind: 'oneshot' });
    expect(invite.claim).toMatch(/^[a-z2-9]{10}$/);
    expect(accounts.claim(invite.claim, 2).tgId).toBe(2);
    expect(accounts.claim(invite.claim, 1)).toBe(null);
    expect(accounts.claim('nope', 1)).toBe(null);
  });

  it('a revoked invite cannot be claimed', () => {
    const { accounts } = setup();
    const invite = accounts.assign({ characterId: 'puup', kind: 'campaign' });
    accounts.revoke(invite.id);
    expect(accounts.claim(invite.claim, 2)).toBe(null);
  });

  it('persists across restarts', () => {
    const { dir, accounts } = setup();
    accounts.assign({ characterId: 'suren', tgId: 1, kind: 'campaign' });
    const again = createAccounts(dir);
    expect(again.user(2).name).toBe('Боря');
    expect(again.forUser(1)).toHaveLength(1);
  });
});
