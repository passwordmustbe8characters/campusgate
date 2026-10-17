'use strict';

// Admin command line until the admin console exists (Phase 6).
//   npm run admin -- unlock <matric/staff ID or email>
//   npm run admin -- status <matric/staff ID or email>
//   npm run admin -- locked
//   npm run admin -- reset-2fa <matric/staff ID or email> --confirm
//
// TODO(Phase 3): record each unlock and 2FA reset in the tamper-evident audit log.

const pino = require('pino');
const Redis = require('ioredis');
const { loadEnvFile } = require('../app/src/config');
const { createLogger } = require('../app/src/logger');
const { createDb } = require('../app/src/db/knex');
const { createTicketStore } = require('../app/src/services/tickets');
const { unlockUser, resetTwoFactor, getUserStatus, listLockedUsers } = require('../app/src/services/userService');

const USAGE = [
  'Usage: npm run admin -- <unlock|status> <matric/staff ID or email>',
  '       npm run admin -- locked',
  '       npm run admin -- reset-2fa <matric/staff ID or email> --confirm',
].join('\n');

/** Revoke a user's pre-auth and account tickets, if Redis is configured. */
async function revokeTickets(userId) {
  if (!process.env.REDIS_URL) return 'skipped (REDIS_URL not set)';
  const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
  redis.on('error', () => {});
  try {
    await redis.connect();
    // revokeUser only reads the per-user index, so no HMAC key is needed here.
    const kinds = ['preauth', 'acct'].map((kind) => createTicketStore({ redis, hmacKey: Buffer.alloc(32), kind, ttlSec: 1 }));
    const counts = await Promise.all(kinds.map((store) => store.revokeUser(userId)));
    return `${counts.reduce((a, b) => a + b, 0)} revoked`;
  } finally {
    redis.disconnect();
  }
}

async function run(args, db, logger) {
  const [command, identifier, ...flags] = args;
  switch (command) {
    case 'unlock': {
      if (!identifier) return { code: 2, out: USAGE };
      const row = await unlockUser(db, identifier);
      if (!row) return { code: 1, out: `No user found for "${identifier}".` };
      logger.info({ event: 'admin_unlock', actor: 'cli', target: row.matric_or_staff_id }, 'account unlocked');
      return { code: 0, out: `Unlocked ${row.matric_or_staff_id} (failed attempts reset to 0).` };
    }
    case 'reset-2fa': {
      if (!identifier) return { code: 2, out: USAGE };
      if (!flags.includes('--confirm')) {
        return {
          code: 2,
          out: `This turns off two-step sign-in for "${identifier}" and deletes its authenticator secret and backup codes.\n` +
            'Re-run with --confirm to do it.',
        };
      }
      const row = await resetTwoFactor(db, identifier);
      if (!row) return { code: 1, out: `No user found for "${identifier}".` };
      const tickets = await revokeTickets(row.id);
      logger.info({ event: 'admin_reset_2fa', actor: 'cli', target: row.matric_or_staff_id, tickets }, 'two-factor reset');
      return {
        code: 0,
        out: `Two-step sign-in reset for ${row.matric_or_staff_id} (backup codes removed: ${row.backupCodesRemoved}; tickets: ${tickets}).\n` +
          'Students can set it up again in Security settings; administrators must enrol an authenticator app at next sign-in.',
      };
    }
    case 'status': {
      if (!identifier) return { code: 2, out: USAGE };
      const row = await getUserStatus(db, identifier);
      if (!row) return { code: 1, out: `No user found for "${identifier}".` };
      return { code: 0, out: JSON.stringify(row, null, 2) };
    }
    case 'locked': {
      const rows = await listLockedUsers(db);
      if (rows.length === 0) return { code: 0, out: 'No accounts are locked.' };
      return {
        code: 0,
        out: rows
          .map((r) => `${r.matric_or_staff_id}\tfailed=${r.failed_attempts}\tlocked_until=${r.locked_until.toISOString()}`)
          .join('\n'),
      };
    }
    default:
      return { code: 2, out: USAGE };
  }
}

async function main() {
  loadEnvFile();
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required (see .env.example)');
    process.exit(2);
  }
  // Structured log lines go to stderr so stdout stays clean for the command's output.
  const logger = createLogger({ level: process.env.LOG_LEVEL || 'info', destination: pino.destination(2) });
  const db = createDb({ databaseUrl: process.env.DATABASE_URL, dbPoolMax: 1 }, logger);
  try {
    const { code, out } = await run(process.argv.slice(2), db, logger);
    (code === 0 ? console.log : console.error)(out);
    process.exitCode = code;
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(`admin command failed: ${err.message}`);
  process.exit(1);
});
