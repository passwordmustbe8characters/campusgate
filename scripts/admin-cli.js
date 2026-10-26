'use strict';

// Admin command line until the admin console exists (Phase 6).
//   npm run admin -- unlock <matric/staff ID or email>
//   npm run admin -- status <matric/staff ID or email>
//   npm run admin -- locked
//   npm run admin -- reset-2fa <matric/staff ID or email> --confirm
//   npm run admin -- policy show
//   npm run admin -- policy set key=value [key=value ...] --confirm
//   npm run admin -- role set <matric/staff ID or email> <student|staff|guest|admin> --confirm
//   npm run admin -- perm list
//   npm run admin -- perm grant|revoke <role> <service> --confirm
//   npm run admin -- history [N]          (policy_history, newest first)
//
// Every change is written to the tamper-evident audit log in the same database
// transaction (fail closed): if the audit row cannot be written, nothing changes.

const pino = require('pino');
const { loadEnvFile } = require('../app/src/config');
const { createLogger } = require('../app/src/logger');
const { createCliAudit } = require('../app/src/audit/cliAudit');
const { createTicketStore } = require('../app/src/services/tickets');
const { revokeUserSessions } = require('../app/src/services/sessions');
const { unlockUser, resetTwoFactor, getUserStatus, listLockedUsers } = require('../app/src/services/userService');
const {
  setPolicy, setRole, changePermission, listPermissions, policyHistory, AdminChangeError,
} = require('../app/src/services/adminChangeService');
const { CHANNEL: PERMISSIONS_CHANNEL } = require('../app/src/policies/permissions');

const USAGE = [
  'Usage: npm run admin -- <unlock|status> <matric/staff ID or email>',
  '       npm run admin -- locked',
  '       npm run admin -- reset-2fa <matric/staff ID or email> --confirm',
  '       npm run admin -- policy show | policy set key=value ... --confirm',
  '       npm run admin -- role set <ID or email> <student|staff|guest|admin> --confirm',
  '       npm run admin -- perm list | perm grant|revoke <role> <service> --confirm',
  '       npm run admin -- history [N]',
].join('\n');

const needConfirm = (what) => ({ code: 2, out: `${what}\nRe-run with --confirm to do it.` });

/** Tell every running app process to reload the permission map (Redis pub/sub). */
async function announcePermissionChange(redis) {
  if (!process.env.REDIS_URL) return 'not announced (REDIS_URL not set): restart the app to pick it up';
  await redis.publish(PERMISSIONS_CHANNEL, String(Date.now()));
  return 'running app processes reload it now';
}

/**
 * Sign a user out everywhere: revoke their pre-auth tickets and session tokens
 * (FR-P6), and record it. Needs Redis, where the denylist lives; without it the
 * user's tokens stay valid until they expire, and the output says so.
 */
async function revokeAccess({ db, audit, ctx, redis }, userId, reason) {
  if (!process.env.REDIS_URL) return 'NOT revoked (REDIS_URL not set): existing sign-ins last until they expire';
  // revokeUser only reads the per-user index, so no HMAC key is needed here.
  const preauth = await createTicketStore({ redis, hmacKey: Buffer.alloc(32), kind: 'preauth', ttlSec: 1 }).revokeUser(userId);
  const count = await revokeUserSessions({ db, redis }, userId, reason);
  await audit.record('sessions_revoked', { userId, success: true, details: { reason, count, actor: 'cli' } }, ctx);
  return `${count} session(s) and ${preauth} pending sign-in(s) revoked`;
}

async function run(args, cli, logger) {
  const { db, audit, ctx, redis } = cli;
  const [command, identifier, ...flags] = args;
  const confirmed = args.includes('--confirm');
  const plain = flags.filter((a) => a !== '--confirm');
  switch (command) {
    case 'policy': {
      if (identifier === 'show') return { code: 0, out: JSON.stringify(await db('policies').where({ id: 1 }).first(), null, 2) };
      if (identifier !== 'set') return { code: 2, out: USAGE };
      if (!confirmed) return needConfirm(`This changes the live policy: ${plain.join(' ')}`);
      const result = await setPolicy(db, audit, plain, ctx);
      if (result.changed.length === 0) return { code: 0, out: 'No change: the policy already has those values.' };
      logger.info({ event: 'policy_changed', actor: 'cli', fields: result.changed }, 'policy changed');
      const summary = result.changed.map((k) => `${k} ${result.before[k]} -> ${result.after[k]}`).join(', ');
      return { code: 0, out: `Policy changed: ${summary}.\nApplies to the next request (no restart).` };
    }
    case 'role': {
      const [who, roleName] = plain;
      if (identifier !== 'set' || !who || !roleName) return { code: 2, out: USAGE };
      if (!confirmed) return needConfirm(`This changes the role of "${who}" to ${roleName}.`);
      const result = await setRole(db, audit, who, roleName, ctx);
      if (!result.changed) return { code: 0, out: `No change: ${result.user.matric_or_staff_id} already has role ${roleName}.` };
      const revoked = await revokeAccess(cli, result.user.id, 'role_changed');
      logger.info({ event: 'role_changed', actor: 'cli', from: result.from, to: result.to }, 'role changed');
      return { code: 0, out: `Role of ${result.user.matric_or_staff_id} changed: ${result.from} -> ${result.to} (${revoked}; they sign in again).` };
    }
    case 'perm': {
      if (identifier === 'list') {
        const rows = await listPermissions(db);
        return { code: 0, out: rows.map((r) => `${r.role.padEnd(8)} ${r.service}`).join('\n') || 'No permissions granted.' };
      }
      const [roleName, service] = plain;
      if (!['grant', 'revoke'].includes(identifier) || !roleName || !service) return { code: 2, out: USAGE };
      if (!confirmed) return needConfirm(`This will ${identifier} "${service}" ${identifier === 'grant' ? 'to' : 'from'} role "${roleName}".`);
      const result = await changePermission(db, audit, identifier, roleName, service, ctx);
      if (!result.changed) return { code: 0, out: `No change: ${roleName} ${identifier === 'grant' ? 'already has' : 'does not have'} ${service}.` };
      const announced = await announcePermissionChange(redis);
      return { code: 0, out: `Permission ${identifier === 'grant' ? 'granted' : 'revoked'}: ${roleName} ${service} (${announced}).` };
    }
    case 'history': {
      const rows = await policyHistory(db, { limit: Number(identifier || 20) });
      if (rows.length === 0) return { code: 0, out: 'No policy, role or permission changes recorded yet.' };
      return {
        code: 0,
        out: rows.map((r) => `${r.changed_at.toISOString()}  ${r.subject.padEnd(15)} ${r.subject_id.padEnd(22)} `
          + `${JSON.stringify(r.old_value)} -> ${JSON.stringify(r.new_value)}  by ${r.actor}`).join('\n'),
      };
    }
    case 'unlock': {
      if (!identifier) return { code: 2, out: USAGE };
      const row = await unlockUser(db, identifier, { audit, ctx });
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
      const row = await resetTwoFactor(db, identifier, { audit, ctx });
      if (!row) return { code: 1, out: `No user found for "${identifier}".` };
      const revoked = await revokeAccess(cli, row.id, 'two_factor_reset');
      logger.info({ event: 'admin_reset_2fa', actor: 'cli', target: row.matric_or_staff_id, revoked }, 'two-factor reset');
      return {
        code: 0,
        out: `Two-step sign-in reset for ${row.matric_or_staff_id} (backup codes removed: ${row.backupCodesRemoved}; ${revoked}).\n` +
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
  const cli = createCliAudit({ logger });
  try {
    const { code, out } = await run(process.argv.slice(2), cli, logger);
    (code === 0 ? console.log : console.error)(out);
    process.exitCode = code;
  } finally {
    await cli.close();
  }
}

main().catch((err) => {
  console.error(`admin command failed: ${err instanceof AdminChangeError ? err.message : err.publicMessage || err.message}`);
  process.exit(1);
});
