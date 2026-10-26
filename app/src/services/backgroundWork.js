'use strict';

/**
 * Tracks fire-and-forget work (emails sent after a response). Graceful
 * shutdown and tests wait for it with idle(); a failure never becomes an
 * unhandled rejection.
 */
function createBackgroundWork() {
  const pending = new Set();
  return {
    track(promise) {
      pending.add(promise);
      promise.finally(() => pending.delete(promise)).catch(() => {});
      return promise;
    },
    idle: () => Promise.allSettled([...pending]),
  };
}

module.exports = { createBackgroundWork };
