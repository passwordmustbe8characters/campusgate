'use strict';

const {
  connectDb, connectRedis, buildRealApp, resetAndSeed, csrfAgent, enableEmail2fa, mailpit, REGISTERED, PASSWORDS,
} = require('./helpers');
const { loadConfig } = require('../../app/src/config');
const { createDelivery } = require('../../app/src/services/delivery');
const { testUrls } = require('./testEnv');

describe('email delivery end to end through real SMTP (Mailpit)', () => {
  let db;
  let redis;
  let delivery;
  const student = REGISTERED[0];

  beforeAll(() => {
    db = connectDb();
    redis = connectRedis();
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: testUrls().databaseUrl,
      REDIS_URL: testUrls().redisUrl,
      CSRF_SECRET: 'x'.repeat(32),
      TOKEN_HMAC_KEY: Buffer.alloc(32, 1).toString('base64'),
      TOTP_ENC_KEY: Buffer.alloc(32, 2).toString('base64'),
      OTP_DELIVERY_DRIVER: 'email',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1025',
    });
    delivery = createDelivery(config, { redis });
  });
  beforeEach(async () => {
    await resetAndSeed(db);
    await redis.flushdb();
    await mailpit.clear();
  });
  afterAll(async () => {
    delivery.close();
    await db.destroy();
    redis.disconnect();
  });

  test('2FA sign-in: the code arrives by email and signs the student in', async () => {
    await enableEmail2fa(db, student.matric_no);
    const { post } = await csrfAgent(buildRealApp({ db, redis, delivery }));
    const login = await post('/auth/login', { identifier: student.matric_no, password: PASSWORDS.student });
    expect(login.body).toMatchObject({ status: 'second_factor_required', codeSent: true });

    const email = await mailpit.latestTo(student.email);
    expect(email.Subject).toBe('Your CampusGate sign-in code');
    expect(email.To[0].Address).toBe(student.email);
    const code = /code is: (\d{6})/.exec(email.Text)[1];

    const res = await post('/auth/otp', { code });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('signed_in');
  });
});
