'use strict';

const { closeServers, settleBackgroundWork } = require('./helpers');

// Real bcrypt + real DB round trips are slower than unit tests.
jest.setTimeout(60000);

// After every test: wait for background emails, then close every server it started.
afterEach(async () => {
  await settleBackgroundWork();
  await closeServers();
});
