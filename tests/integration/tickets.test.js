'use strict';

const { connectRedis, TEST_KEYS } = require('./helpers');
const { createTicketStore } = require('../../app/src/services/tickets');

describe('pre-auth / account ticket store (real Redis)', () => {
  let redis;
  let store;

  beforeAll(() => {
    redis = connectRedis();
    store = createTicketStore({
      redis, hmacKey: Buffer.from(TEST_KEYS.tokenHmacKey, 'base64url'), kind: 'preauth', ttlSec: 300,
    });
  });
  beforeEach(() => redis.flushdb());
  afterAll(() => redis.disconnect());

  test('ticket is a 256-bit random value; Redis stores only its keyed hash, with a TTL', async () => {
    const ticket = await store.issue({ userId: 7, method: 'email' });
    expect(Buffer.from(ticket, 'base64url')).toHaveLength(32);

    const keys = await redis.keys('cg:preauth:*');
    expect(keys.some((k) => k.includes(ticket))).toBe(false);
    const dataKey = keys.find((k) => !k.includes(':user:'));
    expect(await redis.ttl(dataKey)).toBeGreaterThan(290);
    expect(await store.get(ticket)).toMatchObject({ userId: '7', method: 'email', attempts: '0' });
  });

  test('single use: consume returns the data once, then the ticket is gone', async () => {
    const ticket = await store.issue({ userId: 7, method: 'email' });
    expect(await store.consume(ticket)).toMatchObject({ userId: '7' });
    expect(await store.consume(ticket)).toBeNull();
    expect(await store.get(ticket)).toBeNull();
  });

  test('concurrent consumes: exactly one wins', async () => {
    const ticket = await store.issue({ userId: 7, method: 'email' });
    const results = await Promise.all(Array.from({ length: 10 }, () => store.consume(ticket)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test('attempt limit: the attempt after the limit deletes the ticket and returns -1', async () => {
    const ticket = await store.issue({ userId: 7, method: 'email' });
    expect(await store.attempt(ticket, 3)).toBe(1);
    expect(await store.attempt(ticket, 3)).toBe(2);
    expect(await store.attempt(ticket, 3)).toBe(3);
    expect(await store.attempt(ticket, 3)).toBe(-1);
    expect(await store.get(ticket)).toBeNull();
  });

  test('10 concurrent attempts with a limit of 5: exactly 5 succeed', async () => {
    const ticket = await store.issue({ userId: 7, method: 'email' });
    const results = await Promise.all(Array.from({ length: 10 }, () => store.attempt(ticket, 5)));
    expect(results.filter((n) => n > 0).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  test('revokeUser removes every ticket for that user only', async () => {
    const a = await store.issue({ userId: 7, method: 'email' });
    const b = await store.issue({ userId: 7, method: 'email' });
    const other = await store.issue({ userId: 8, method: 'email' });
    expect(await store.revokeUser(7)).toBe(2);
    expect(await store.get(a)).toBeNull();
    expect(await store.get(b)).toBeNull();
    expect(await store.get(other)).not.toBeNull();
  });

  test('malformed or missing ticket values are rejected without touching Redis keys', async () => {
    for (const bad of [undefined, '', 'short', 'x'.repeat(43) + '!', { $ne: 1 }]) {
      expect(await store.get(bad)).toBeNull();
      expect(await store.attempt(bad, 5)).toBe(-1);
      expect(await store.consume(bad)).toBeNull();
    }
  });
});
