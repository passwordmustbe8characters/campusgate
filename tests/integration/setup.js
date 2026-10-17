'use strict';

const { closeServers } = require('./helpers');

// Real bcrypt + real DB round trips are slower than unit tests.
jest.setTimeout(60000);

// Close every server a test started with listen()/csrfAgent().
afterEach(closeServers);
