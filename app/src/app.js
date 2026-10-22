'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const pinoHttp = require('pino-http');
const cookieParser = require('cookie-parser');
const { errSerializer } = require('./logger');

const { healthRouter } = require('./routes/health');
const { authRouter } = require('./routes/auth');
const { pagesRouter } = require('./routes/pages');
const { createCsrf } = require('./middleware/csrf');
const { ticketCookies, requireAccountTicket } = require('./middleware/tickets');
const { notFound } = require('./middleware/notFound');
const { errorHandler } = require('./middleware/errorHandler');
const { createHasher } = require('./services/passwordHasher');
const { createAuthService } = require('./services/authService');
const { createTicketStore } = require('./services/tickets');
const { createDelivery } = require('./services/delivery');
const { createOtpService } = require('./services/otpService');
const { createTotpService } = require('./services/totpService');
const { createPasswordService } = require('./services/passwordService');
const { createMetrics } = require('./services/metrics');
const { createPermissions } = require('./policies/permissions');
const { createPasswordController } = require('./controllers/passwordController');
const { createSecondFactorService } = require('./services/secondFactorService');
const { createAccountSettingsService } = require('./services/accountSettingsService');
const { createAuthController } = require('./controllers/authController');
const { createSettingsController } = require('./controllers/settingsController');

/** Wire services together. Exposed separately so scripts and tests can reuse it. */
function createServices({ config, logger, db, redis, hasher, delivery, clock }) {
  const preauthTickets = createTicketStore({
    redis, hmacKey: config.tokenHmacKey, kind: 'preauth', ttlSec: config.preauthTtlSec,
  });
  // TODO(Phase 4): delete the interim account ticket; use the JWT session.
  const accountTickets = createTicketStore({
    redis, hmacKey: config.tokenHmacKey, kind: 'acct', ttlSec: config.accountTicketTtlMin * 60,
  });
  const otp = createOtpService({
    db, redis, delivery, hmacKey: config.tokenHmacKey, cooldownSec: config.otpResendCooldownSec,
  });
  const totp = createTotpService({ db, redis, encKey: config.totpEncKey, hmacKey: config.tokenHmacKey, clock });
  const secondFactor = createSecondFactorService({
    db,
    preauthTickets,
    otp,
    verifiers: { totp: totp.verifyLogin, backup: totp.verifyBackupCode },
    maxAttempts: config.preauthMaxAttempts,
    logger,
  });
  const metrics = createMetrics({ redis, logger });
  return {
    permissions: createPermissions({ db, redis, logger }),
    preauthTickets,
    accountTickets,
    otp,
    totp,
    secondFactor,
    metrics,
    authService: createAuthService({ db, hasher, logger }),
    settingsService: createAccountSettingsService({ db, otp, totp, logger }),
    passwordService: createPasswordService({
      db, redis, hasher, delivery, config, tickets: [preauthTickets, accountTickets], metrics, logger,
    }),
  };
}

/**
 * Build the Express app. Dependencies are passed in (not imported) so tests can
 * supply fakes and so each cluster worker owns its own connections.
 */
function createApp({
  config,
  logger,
  db,
  redis,
  hasher = createHasher(config.bcryptCost),
  delivery = createDelivery(config, { redis }),
  clock, // optional { now() } for tests; defaults to the real clock
}) {
  const app = express();
  const csrf = createCsrf(config);
  const cookies = ticketCookies(config);
  const services = createServices({ config, logger, db, redis, hasher, delivery, clock });
  const ticketDeps = { accountTickets: services.accountTickets, cookies };
  const requireAccount = requireAccountTicket(ticketDeps);
  const requireAccountOrEnrolment = requireAccountTicket(ticketDeps, { allowEnrolment: true });

  const controller = createAuthController({ ...services, cookies });
  const settings = createSettingsController({ ...services, cookies });
  const passwords = createPasswordController({ passwordService: services.passwordService, cookies });

  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('view engine', 'ejs');

  app.use(helmet());
  app.use(
    pinoHttp({
      logger,
      // Keep our err serializer on request loggers too (drops DB values such as pg `detail`).
      serializers: { err: errSerializer },
      genReqId: (req, res) => {
        const id = randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/health' || req.url.startsWith('/public/') },
    }),
  );
  app.use('/public', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(cookieParser());

  app.use(healthRouter({ db, redis, timeoutMs: config.healthCheckTimeoutMs }));

  // Every non-GET/HEAD/OPTIONS request below this line needs a valid CSRF token.
  app.use(csrf.doubleCsrfProtection);
  app.use(pagesRouter({ db, csrf, requireAccountOrEnrolment, settingsService: services.settingsService }));
  app.use(authRouter({ controller, settings, passwords, requireAccount, requireAccountOrEnrolment }));

  app.use(notFound);
  app.use(errorHandler(logger));

  // Lets graceful shutdown (and tests) wait for background emails to finish.
  app.set('background', { idle: () => services.passwordService.idle() });
  // Start-up / shutdown hooks for long-lived resources (permission map subscriber).
  app.set('services', services);
  return app;
}

module.exports = { createApp, createServices };

