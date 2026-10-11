'use strict';

const request = require('supertest');
const { buildTestApp } = require('./helpers');

describe('GET /health', () => {
  test('returns 200 ok when PostgreSQL and Redis respond', async () => {
    const res = await request(buildTestApp()).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.postgres.status).toBe('ok');
    expect(res.body.checks.redis.status).toBe('ok');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('returns 503 when PostgreSQL is down, without leaking the error text', async () => {
    const db = { raw: async () => { throw new Error('password authentication failed for user "secret"'); } };
    const res = await request(buildTestApp({ db })).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.postgres).toEqual({ status: 'error' });
    expect(res.body.checks.redis.status).toBe('ok');
    expect(JSON.stringify(res.body)).not.toMatch(/password|secret/);
  });

  test('returns 503 when Redis is down', async () => {
    const redis = { ping: async () => { throw new Error('ECONNREFUSED'); } };
    const res = await request(buildTestApp({ redis })).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.checks.redis).toEqual({ status: 'error' });
  });

  test('times out a hanging dependency instead of hanging the request', async () => {
    const redis = { ping: () => new Promise(() => {}) };
    const started = Date.now();
    const res = await request(buildTestApp({ redis })).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.checks.redis.status).toBe('error');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
