'use strict';

// Admin command line for Phase 1, until the admin console exists (Phase 6).
//   npm run admin -- unlock <matric/staff ID or email>
//   npm run admin -- status <matric/staff ID or email>
//   npm run admin -- locked
//
// TODO(Phase 3): record each unlock in the tamper-evident audit log.

const knex = require('knex');
const pino = require('pino');
const { loadEnvFile } = require('../app/src/config');
const { createLogger } = require('../app/src/logger');
const { unlockUser, getUserStatus, listLockedUsers } = require('../app/src/services/userService');

const USAGE = 'Usage: npm run admin -- <unlock|status> <matric/staff ID or email>\n       npm run admin -- locked';

async function run(command, identifier, db, logger) {
  switch (command) {
    case 'unlock': {
      if (!identifier) return { code: 2, out: USAGE };
      const row = await unlockUser(db, identifier);
      if (!row) return { code: 1, out: `No user found for "${identifier}".` };
      logger.info({ event: 'admin_unlock', actor: 'cli', target: row.matric_or_staff_id }, 'account unlocked');
      return { code: 0, out: `Unlocked ${row.matric_or_staff_id} (failed attempts reset to 0).` };
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
  const [command, identifier] = process.argv.slice(2);
  const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } });
  // Structured log lines go to stderr so stdout stays clean for the command's output.
  const logger = createLogger({ level: process.env.LOG_LEVEL || 'info', destination: pino.destination(2) });
  try {
    const { code, out } = await run(command, identifier, db, logger);
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
