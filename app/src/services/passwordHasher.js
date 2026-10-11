'use strict';

const { randomBytes } = require('node:crypto');
const bcrypt = require('bcrypt');

/**
 * bcrypt wrapper (FR-A4). Uses the async API only: hashing runs on libuv's
 * thread pool, never synchronously on the event loop.
 *
 * dummyHash() is a hash of a random secret at the SAME cost as real hashes.
 * Login compares against it when the account does not exist (or must not be
 * checked), so response time does not reveal whether an account exists.
 */
function createHasher(cost) {
  let dummy;

  return {
    cost,
    hash: (password) => bcrypt.hash(password, cost),
    compare: (password, hash) => bcrypt.compare(password, hash),
    dummyHash() {
      if (!dummy) {
        dummy = bcrypt.hash(randomBytes(32).toString('hex'), cost).catch((err) => {
          dummy = undefined;
          throw err;
        });
      }
      return dummy;
    },
  };
}

/** Cost factor encoded in a bcrypt hash ("$2b$12$..." -> 12). */
function costOf(hash) {
  return Number(hash.split('$')[2]);
}

module.exports = { createHasher, costOf };
