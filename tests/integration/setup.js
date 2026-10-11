'use strict';

// Real bcrypt + real DB round trips are slower than unit tests.
jest.setTimeout(60000);
