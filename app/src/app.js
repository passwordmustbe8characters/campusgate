'use strict';

const { randomUUID } = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const pinoHttp = require('pino-http');

const { healthRouter } = require('./routes/health');
const { notFound } = require('./middleware/notFound');
const { errorHandler } = require('./middleware/errorHandler');

/**
 * Build the Express app. Dependencies are passed in (not imported) so tests can
 * supply fakes and so each cluster worker owns its own connections.
 */
function createApp({ config, logger, db, redis }) {
  const app = express();

  app.use(helmet());
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/health' },
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  app.use(healthRouter({ db, redis, timeoutMs: config.healthCheckTimeoutMs }));

  app.use(notFound);
  app.use(errorHandler(logger));

  return app;
}

module.exports = { createApp };
