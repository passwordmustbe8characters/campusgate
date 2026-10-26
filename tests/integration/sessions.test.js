'use strict';

const jwt = require('jsonwebtoken');
const { connectDb, connectRedis, resetAndSeed, userRow, REGISTERED, TEST_KEYS } = require('./helpers');
const { createSessionService, revokeUserSessions, denylistKey, ISSUER, AUDIENCE } = require('../../app/src/services/sessions');

const SECRET = Buffer.from(TEST_KEYS.jwtSecret, 'base64url');

describe('session tokens and the sessions table (real PostgreSQL and Redis)', () => {
  let db;
  let redis;
  let sessions;
  let user;
  let other;

  beforeAll(() => {
    db = connectDb();
    redis = connectRedis();
    sessions = createSessionService({ db, redis, jwtSecret: SECRET });
  });
  beforeEach(async () => {
    await redis.flushdb();
    await resetAndSeed(db);
    user = await userRow(db, REGISTERED[0].matric_no);
    other = await userRow(db, REGISTERED[1].matric_no);
  });
  afterAll(async () => {
    await db.destroy();
    redis.disconnect();
  });

  const issue = (u = user, extra = {}) =>
    sessions.issue({ userId: u.id, role: 'student', ttlMin: 30, ip: '127.0.0.1', userAgent: 'jest', ...extra });

  test('issue: HS256 token with user, role, scope, jti, issuer, audience and a lifetime of ttlMin', async () => {
    const { token, jti, expiresAt, maxAgeMs } = await issue();
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url'));
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' });
    const claims = jwt.decode(token);
    expect(claims).toMatchObject({ sub: String(user.id), role: 'student', scope: 'full', jti, iss: ISSUER, aud: AUDIENCE });
    expect(claims.exp - claims.iat).toBe(30 * 60);
    expect(maxAgeMs).toBe(30 * 60 * 1000);
    expect(expiresAt.getTime()).toBe(claims.exp * 1000);
    // The token never contains the email, matric number or anything secret.
    expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'jti', 'role', 'scope', 'sub']);
  });

  test('issue writes a session record (FR-L2) with start, expiry, IP and user agent; no token stored', async () => {
    const { token, jti } = await issue();
    const row = await db('sessions').where({ jti }).first();
    expect(row).toMatchObject({ user_id: String(user.id), scope: 'full', ip: '127.0.0.1', user_agent: 'jest', revoked_at: null });
    expect(row.expires_at.getTime() - row.created_at.getTime()).toBe(30 * 60 * 1000);
    expect(JSON.stringify(row)).not.toContain(token);
  });

  test('verify accepts a good token and returns its claims', async () => {
    const { token, jti } = await issue();
    expect(sessions.verify(token)).toMatchObject({ userId: Number(user.id), role: 'student', scope: 'full', jti });
  });

  test('verify rejects tampered, wrongly signed, "none"-algorithm, expired and malformed tokens', async () => {
    const { token } = await issue();
    const [h, p, s] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ ...jwt.decode(token), role: 'admin' })).toString('base64url');
    const bad = [
      `${h}.${forgedPayload}.${s}`, // payload changed, old signature
      jwt.sign({ sub: String(user.id), role: 'student', scope: 'full' }, 'another-secret-another-secret-123',
        { algorithm: 'HS256', jwtid: 'x', issuer: ISSUER, audience: AUDIENCE }),
      `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${p}.`,
      jwt.sign({ sub: String(user.id), role: 'student', scope: 'full', iat: 1000 }, SECRET,
        { algorithm: 'HS256', expiresIn: 60, jwtid: 'x', issuer: ISSUER, audience: AUDIENCE }), // expired
      jwt.sign({ sub: String(user.id), role: 'student', scope: 'full' }, SECRET,
        { algorithm: 'HS256', expiresIn: 60, jwtid: 'x', issuer: 'someone-else', audience: AUDIENCE }),
      jwt.sign({ sub: 'abc', role: 'student', scope: 'full' }, SECRET,
        { algorithm: 'HS256', expiresIn: 60, jwtid: 'x', issuer: ISSUER, audience: AUDIENCE }), // bad subject
      jwt.sign({ sub: String(user.id), role: 'student', scope: 'root' }, SECRET,
        { algorithm: 'HS256', expiresIn: 60, jwtid: 'x', issuer: ISSUER, audience: AUDIENCE }), // unknown scope
      undefined, '', 'not.a.token', 'x'.repeat(5000), { token },
    ];
    for (const value of bad) expect(sessions.verify(value)).toBeNull();
  });

  test('revoke: the jti goes on the Redis denylist until the token would expire, and the record is closed', async () => {
    const { jti } = await issue();
    expect(await sessions.isRevoked(jti)).toBe(false);
    expect(await sessions.revoke(jti, 'logout')).toBe(true);
    expect(await sessions.isRevoked(jti)).toBe(true);
    const ttl = await redis.pttl(denylistKey(jti));
    expect(ttl).toBeGreaterThan(29 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(30 * 60 * 1000 + 5000);
    expect(await db('sessions').where({ jti }).first()).toMatchObject({ revoke_reason: 'logout' });
    // Revoking again reports that it was no longer live, and changes nothing.
    expect(await sessions.revoke(jti, 'logout_all')).toBe(false);
    expect((await db('sessions').where({ jti }).first()).revoke_reason).toBe('logout');
    expect(await sessions.revoke('00000000-0000-4000-8000-000000000000', 'logout')).toBe(false);
  });

  test('revokeUser revokes every live session of that user only, and skips expired ones', async () => {
    const a = await issue();
    const b = await issue();
    const theirs = await issue(other);
    const { jti: oldJti } = await issue(user, { ttlMin: 1 });
    await db('sessions').where({ jti: oldJti }).update({
      created_at: db.raw("now() - interval '2 hours'"), expires_at: db.raw("now() - interval '1 hour'"),
    });

    expect(await sessions.revokeUser(user.id, 'password_changed')).toBe(2);
    expect(await sessions.isRevoked(a.jti)).toBe(true);
    expect(await sessions.isRevoked(b.jti)).toBe(true);
    expect(await sessions.isRevoked(theirs.jti)).toBe(false);
    expect(await redis.exists(denylistKey(oldJti))).toBe(0);
    const reasons = await db('sessions').where({ user_id: user.id }).whereNotNull('revoked_at').pluck('revoke_reason');
    expect(reasons).toEqual(['password_changed', 'password_changed']);
    // Again: nothing new is ended, so the count is 0 (the jtis are re-listed on the denylist anyway).
    expect(await sessions.revokeUser(user.id, 'logout_all')).toBe(0);
    expect(await sessions.isRevoked(a.jti)).toBe(true);
  });

  test('revokeUserSessions works without the signing key (used by the admin CLI)', async () => {
    const { jti } = await issue();
    expect(await revokeUserSessions({ db, redis }, user.id, 'role_changed')).toBe(1);
    expect(await sessions.isRevoked(jti)).toBe(true);
  });

  test('a failed Redis write leaves the record open, and a later revokeUser still denylists it', async () => {
    const { jti } = await issue();
    const broken = connectRedis('redis://127.0.0.1:1', { maxRetriesPerRequest: 0, enableOfflineQueue: false, lazyConnect: true });
    await expect(revokeUserSessions({ db, redis: broken }, user.id, 'logout_all')).rejects.toThrow();
    expect((await db('sessions').where({ jti }).first()).revoked_at).toBeNull();
    expect(await sessions.revokeUser(user.id, 'logout_all')).toBe(1);
    expect(await sessions.isRevoked(jti)).toBe(true);
  });

  test('isRevoked throws when Redis is unreachable, so callers can fail closed', async () => {
    const broken = connectRedis('redis://127.0.0.1:1', { maxRetriesPerRequest: 0, enableOfflineQueue: false, lazyConnect: true });
    const down = createSessionService({ db, redis: broken, jwtSecret: SECRET });
    await expect(down.isRevoked('any')).rejects.toThrow();
  });

  test('the database enforces the record rules', async () => {
    const { jti } = await issue();
    await expect(db('sessions').insert({ user_id: user.id, jti, scope: 'full', expires_at: db.raw("now() + interval '1 minute'") }))
      .rejects.toThrow(/duplicate key/);
    await expect(db('sessions').insert({ user_id: user.id, jti: '00000000-0000-4000-8000-000000000001', scope: 'root', expires_at: db.raw("now() + interval '1 minute'") }))
      .rejects.toThrow(/check constraint/);
    await expect(db('sessions').where({ jti }).update({ revoked_at: db.fn.now() })).rejects.toThrow(/check constraint/);
    await expect(db('sessions').insert({ user_id: user.id, jti: '00000000-0000-4000-8000-000000000002', scope: 'full', expires_at: db.raw("now() - interval '1 minute'") }))
      .rejects.toThrow(/check constraint/);
  });

  test('deleting a user deletes their session records', async () => {
    await issue();
    await issue(other);
    await db('users').where({ id: user.id }).del();
    expect(await db('sessions').where({ user_id: user.id })).toHaveLength(0);
    expect(await db('sessions').where({ user_id: other.id })).toHaveLength(1);
  });
});
