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
const { portalRouter } = require('./routes/portal');
const { createPortalService } = require('./services/portalService');
const { createCsrf } = require('./middleware/csrf');
const { sessionCookies, requireSession, requireRecentSignIn } = require('./middleware/session');
const { createRateLimiter } = require('./middleware/rateLimit');
const { requireAdmission } = require('./middleware/admission');
const { queueRouter } = require('./routes/queue');
const { createWaitingRoom } = require('./services/waitingRoom');
const { createDashboard, createLoginTimer } = require('./services/dashboard');
const { adminRouter } = require('./routes/admin');
const { emailPagesRouter } = require('./routes/emailPages');
const { createRiskService } = require('./services/risk');
const { createEmailVerification } = require('./services/emailVerification');
const { createDeviceAlert } = require('./services/deviceAlert');
const { notFound } = require('./middleware/notFound');
const { errorHandler } = require('./middleware/errorHandler');
const { createHasher } = require('./services/passwordHasher');
const { createAuthService } = require('./services/authService');
const { createTicketStore } = require('./services/tickets');
const { createSessionService } = require('./services/sessions');
const { createDelivery } = require('./services/delivery');
const { createOtpService } = require('./services/otpService');
const { createTotpService } = require('./services/totpService');
const { createPasswordService } = require('./services/passwordService');
const { createMetrics } = require('./services/metrics');
const { createPermissions } = require('./policies/permissions');
const { getPolicy } = require('./policies/policyRepo');
const { createAudit } = require('./audit/audit');
const { createPasswordController } = require('./controllers/passwordController');
const { createSecondFactorService } = require('./services/secondFactorService');
const { createAccountSettingsService } = require('./services/accountSettingsService');
const { createAuthController } = require('./controllers/authController');
const { createSettingsController } = require('./controllers/settingsController');

/** Wire services together. Exposed separately so scripts and tests can reuse it. */
function createServices({ config, logger, db, redis, hasher, delivery, clock, auditWriter }) {
  const metrics = createMetrics({ redis, logger });
  // Audit log (FR-L1/L3). Sync mode unless an auditWriter (queue mode, Phase 3.3) is given.
  const audit = createAudit({ db, redis, config, logger, metrics, writer: auditWriter });
  const preauthTickets = createTicketStore({
    redis, hmacKey: config.tokenHmacKey, kind: 'preauth', ttlSec: config.preauthTtlSec,
  });
  // Login-once session tokens (FR-P1) and their revocation (FR-P6).
  const sessions = createSessionService({ db, redis, jwtSecret: config.jwtSecret });
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
    audit,
  });
  const waitingRoom = createWaitingRoom({
    redis, hmacKey: config.tokenHmacKey, passTtlSec: config.queuePassTtlSec, ticketTimeoutSec: config.queueTicketTimeoutSec,
  });
  return {
    permissions: createPermissions({ db, redis, logger }),
    audit,
    preauthTickets,
    sessions,
    otp,
    totp,
    secondFactor,
    metrics,
    portalService: createPortalService({ db }),
    waitingRoom,
    dashboard: createDashboard({ db, redis, waitingRoom }),
    recordLoginTime: createLoginTimer({ redis, logger }),
    authService: createAuthService({
      db, hasher, logger, audit,
      risk: config.riskScoring ? createRiskService({ db, now: clock ? () => new Date(clock.now()) : undefined }) : null,
    }),
    emailVerification: createEmailVerification({ db, redis, delivery, config, metrics, logger, audit }),
    deviceAlert: createDeviceAlert({ db, delivery, metrics, logger, audit }),
    settingsService: createAccountSettingsService({ db, otp, totp, logger, audit }),
    passwordService: createPasswordService({
      db, redis, hasher, delivery, config, tickets: [preauthTickets], sessions, metrics, logger, audit,
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
  const cookies = sessionCookies(config);
  const services = createServices({ config, logger, db, redis, hasher, delivery, clock });
  const sessionDeps = { sessions: services.sessions, cookies };
  const requireSignedIn = requireSession(sessionDeps);
  const requireSignedInOrEnrolment = requireSession(sessionDeps, { allowEnrolment: true });
  const recent = requireRecentSignIn();
  const rateLimiter = createRateLimiter({
    redis,
    hmacKey: config.tokenHmacKey,
    perIpPerMin: config.rateLimitIpPerMin,
    perAccountPerMin: config.rateLimitAccountPerMin,
    metrics: services.metrics,
  });

  const policyNow = () => getPolicy(db);
  const controller = createAuthController({ ...services, cookies, getPolicy: policyNow });
  const admission = requireAdmission({ waitingRoom: services.waitingRoom, getPolicy: policyNow, cookies, db });
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
  // One-line notices on the sign-in page (?verified=1, ?admitted=1), read by the template.
  app.use((req, res, next) => {
    res.locals.flags = { verified: req.query.verified === '1', admitted: req.query.admitted === '1' };
    next();
  });

  // Every non-GET/HEAD/OPTIONS request below this line needs a valid CSRF token.
  app.use(csrf.doubleCsrfProtection);
  // pagesRouter's requireAccountOrEnrolment slot now takes the session check (security settings page).
  app.use(pagesRouter({ db, csrf, requireAccountOrEnrolment: requireSignedInOrEnrolment, settingsService: services.settingsService }));
  app.use(authRouter({ controller, settings, passwords, requireSignedIn, requireSignedInOrEnrolment, recent, rateLimiter, admission }));
  app.use(queueRouter({ csrf, waitingRoom: services.waitingRoom, getPolicy: policyNow, cookies }));
  app.use(emailPagesRouter({ csrf }));
  app.use(adminRouter({ db, redis, config, csrf, requireSignedIn, recent, permissions: services.permissions, services }));
  app.use(portalRouter({ csrf, requireSignedIn, permissions: services.permissions, portalService: services.portalService }));

  app.use(notFound);
  app.use(errorHandler(logger));

  // Lets graceful shutdown (and tests) wait for background emails to finish.
  app.set('background', {
    idle: () => Promise.all([services.passwordService.idle(), services.emailVerification.idle(), services.deviceAlert.idle()]),
  });
  // Start-up / shutdown hooks for long-lived resources (permission map subscriber).
  app.set('services', services);
  return app;
}

module.exports = { createApp, createServices };

