'use strict';

const { closeServers, settleBackgroundWork, closeAllResources } = require('./helpers');

// Real bcrypt + real DB round trips are slower than unit tests.
jest.setTimeout(60000);

// After every test: wait for background emails, then close every server it started.
afterEach(async () => {
  await settleBackgroundWork();
  await closeServers();
});

// After every test file: close any DB pool, Redis client or SMTP transport that
// is still open (normally the file's own afterAll already did; closing twice is safe).
afterAll(closeAllResources);
