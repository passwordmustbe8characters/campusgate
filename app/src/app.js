'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const pinoHttp = require('pino-http');
const cookieParser = require('cookie-parser');

const { healthRouter } = require('./routes/health');
const { authRouter } = require('./routes/auth');
const { pagesRouter } = require('./routes/pages');
const { createCsrf } = require('./middleware/csrf');
const { notFound } = require('./middleware/notFound');
const { errorHandler } = require('./middleware/errorHandler');
const { createHasher } = require('./services/passwordHasher');
const { createAuthService } = require('./services/authService');
const { createAuthController } = require('./controllers/authController');

/**
 * Build the Express app. Dependencies are passed in (not imported) so tests can
 * supply fakes and so each cluster worker owns its own connections.
 */
function createApp({ config, logger, db, redis, hasher = createHasher(config.bcryptCost) }) {
  const app = express();
  const csrf = createCsrf(config);
  const authController = createAuthController(createAuthService({ db, hasher, logger }));

  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('view engine', 'ejs');

  app.use(helmet());
  app.use(
    pinoHttp({
      logger,
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
  app.use(pagesRouter({ db, csrf }));
  app.use(authRouter(authController));

  app.use(notFound);
  app.use(errorHandler(logger));

  return app;
}

module.exports = { createApp };
