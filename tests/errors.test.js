'use strict';

const express = require('express');
const request = require('supertest');
const { createLogger } = require('../app/src/logger');
const { errorHandler } = require('../app/src/middleware/errorHandler');
const { buildTestApp } = require('./helpers');

describe('error handling (NFR-8)', () => {
  test('unknown routes return a JSON 404', async () => {
    const res = await request(buildTestApp()).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not Found' });
  });

  test('malformed JSON returns a generic 400', async () => {
    const res = await request(buildTestApp())
      .post('/health')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Bad Request');
    expect(res.body.requestId).toEqual(expect.any(String));
  });

  test('a thrown error returns a generic 500 with no stack trace or message', async () => {
    const app = express();
    app.get('/boom', async () => {
      throw new Error('db column users.password_hash exploded');
    });
    app.use(errorHandler(createLogger({ level: 'silent' })));

    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal Server Error');
    expect(res.text).not.toMatch(/password_hash|exploded|at .*\.js/);
  });
});

describe('security headers (NFR-1)', () => {
  test('helmet headers are set and X-Powered-By is removed', async () => {
    const res = await request(buildTestApp()).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-request-id']).toEqual(expect.any(String));
  });
});
