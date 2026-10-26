'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
  connectDb, connectRedis, resetAndSeed, buildRealApp, csrfAgent, cliEnv, waitFor, trackForTeardown,
  TEST_KEYS, REGISTERED, PASSWORDS,
} = require('./helpers');
const { appendEvents, updateAnchor, verifyChain } = require('../../app/src/audit/chain');
const { buildEvent } = require('../../app/src/audit/events');
const { createLogger } = require('../../app/src/logger');
const { createPermissions } = require('../../app/src/policies/permissions');

const execFileP = promisify(execFile);
const ROOT = path.join(__dirname, '..', '..');
const AUDIT_KEY = Buffer.from(TEST_KEYS.auditHmacKey, 'base64url');
const ROWS = 3000;

// Each test starts several CLI processes; give slow machines room (hang guard only).
jest.setTimeout(240000);

/** Run a CLI script; resolves { code, out } whatever the exit code. */
async function cli(script, args, env = cliEnv()) {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [path.join(ROOT, 'scripts', script), ...args], { cwd: ROOT, env });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    return { code: err.code, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
}
const audit = (...args) => cli('audit-cli.js', args);
const admin = (...args) => cli('admin-cli.js', args);

/** As the table owner, switch the append-only triggers off for one statement (how tampering is simulated). */
async function tamper(db, sql, bindings = []) {
  await db.transaction(async (trx) => {
    await trx.raw('ALTER TABLE auth_logs DISABLE TRIGGER auth_logs_no_update_delete');
    await trx.raw(sql, bindings);
    await trx.raw('ALTER TABLE auth_logs ENABLE TRIGGER auth_logs_no_update_delete');
  });
}

async function withAuditWritesFailing(db, fn) {
  await db.raw('ALTER TABLE auth_logs ADD CONSTRAINT audit_test_reject CHECK (false) NOT VALID');
  try {
    return await fn();
  } finally {
    await db.raw('ALTER TABLE auth_logs DROP CONSTRAINT audit_test_reject');
  }
}

describe('audit tools: verify, search, export; admin policy/role/permission commands (FR-L3, L4, Z5)', () => {
  let db;
  let redis;

  beforeAll(() => {
    db = connectDb();
    redis = connectRedis();
  });
  beforeEach(async () => {
    await resetAndSeed(db);
    await redis.flushdb();
  });
  afterAll(async () => {
    await db.destroy();
    redis.disconnect();
  });

  /** Write `n` events into the chain (in batches) and record the anchor, like the app does. */
  async function seedChain(n, makeCtx = () => ({ ip: '10.0.0.1', userAgent: 'Mozilla/5.0' })) {
    let head;
    for (let i = 0; i < n; i += 500) {
      const batch = Array.from({ length: Math.min(500, n - i) }, (_, j) => buildEvent(
        (i + j) % 3 === 0 ? 'login_failure' : 'login_success',
        (i + j) % 3 === 0
          ? { userId: 1, success: false, details: { reason: 'bad_password', stage: 'password' } }
          : { userId: 1, success: true, details: { method: 'password' } },
        makeCtx(i + j),
      ));
      ({ head } = await db.transaction((trx) => appendEvents(trx, AUDIT_KEY, batch)));
    }
    await updateAnchor(redis, head);
  }

  describe('verify (streams the chain in pages, reports the first broken seq and why)', () => {
    test(`a clean chain of ${ROWS} rows verifies OK (exit 0), in pages smaller than the table`, async () => {
      await seedChain(ROWS);
      const paged = await verifyChain(db, AUDIT_KEY, { pageSize: 500 });
      expect(paged).toMatchObject({ ok: true, checked: ROWS, lastSeq: ROWS });

      const res = await audit('verify');
      expect(res.code).toBe(0);
      expect(res.out).toMatch(new RegExp(`Checked ${ROWS} rows in \\d+ ms \\(anchor: seq ${ROWS}\\)`));
      expect(res.out).toContain(`OK: the chain is intact up to seq ${ROWS}.`);
      // The verification itself was recorded (fail closed).
      expect(await db('auth_logs').where({ event_type: 'audit_verified' })).toHaveLength(1);
    });

    test('EDITED row: detected at that seq (row_hash)', async () => {
      await seedChain(ROWS);
      await tamper(db, `UPDATE auth_logs SET details = '{"method": "hacked"}' WHERE seq = 1500`);
      const res = await audit('verify');
      expect(res.code).toBe(1);
      expect(res.out).toContain('BROKEN at seq 1500: row_hash (row content does not match its hash).');
    });

    test('DELETED middle row: detected as a gap', async () => {
      await seedChain(ROWS);
      await tamper(db, 'DELETE FROM auth_logs WHERE seq = 1200');
      const res = await audit('verify');
      expect(res.code).toBe(1);
      expect(res.out).toContain('BROKEN at seq 1200: gap (seq 1200 is missing (next is 1201)).');
    });

    test('REORDERED rows (two rows swapped): detected at the first moved row (prev_hash)', async () => {
      await seedChain(ROWS);
      await tamper(db, `
        UPDATE auth_logs SET seq = 999999 WHERE seq = 100;
        UPDATE auth_logs SET seq = 100 WHERE seq = 101;
        UPDATE auth_logs SET seq = 101 WHERE seq = 999999;`);
      const res = await audit('verify');
      expect(res.code).toBe(1);
      expect(res.out).toContain('BROKEN at seq 100: prev_hash (row does not link to the previous row).');
    });

    test('NEWEST rows deleted: the chain alone looks fine, but the outside anchor catches it (tail)', async () => {
      await seedChain(ROWS);
      await tamper(db, `DELETE FROM auth_logs WHERE seq > ${ROWS - 10}`);
      const chainOnly = await verifyChain(db, AUDIT_KEY); // no anchor: cannot tell
      expect(chainOnly.ok).toBe(true);

      const res = await audit('verify');
      expect(res.code).toBe(1);
      expect(res.out).toContain(`BROKEN at seq ${ROWS - 9}: tail (anchor says seq ${ROWS} exists; database ends at ${ROWS - 10}).`);
    });

    test('WRONG or lost AUDIT_HMAC_KEY: nothing verifies (first row fails)', async () => {
      await seedChain(50);
      const res = await cli('audit-cli.js', ['verify'], cliEnv({ AUDIT_HMAC_KEY: Buffer.alloc(32, 99).toString('base64url') }));
      expect(res.code).toBe(1);
      expect(res.out).toContain('BROKEN at seq 1: row_hash');
    });
  });

  describe('search and export (FR-L4)', () => {
    test('search filters by type and success', async () => {
      await seedChain(30);
      const res = await audit('search', '--type', 'login_failure', '--success', 'false', '--limit', '5');
      expect(res.code).toBe(0);
      const lines = res.out.trim().split('\n');
      expect(lines).toHaveLength(5);
      expect(lines.every((l) => l.includes('login_failure') && l.includes('FAIL'))).toBe(true);
    });

    test('export writes a CSV, neutralizes formula cells (attacker-controlled user agent), and is itself audited', async () => {
      const evilUa = '=HYPERLINK("http://evil.example","Click me")';
      await seedChain(12, (i) => ({ ip: '10.0.0.2', userAgent: i === 0 ? evilUa : 'Mozilla/5.0' }));
      const out = path.join(os.tmpdir(), `cg-export-${process.pid}.csv`);
      trackForTeardown(out, async () => fs.rmSync(out, { force: true }));

      const res = await audit('export', '--out', out, '--type', 'login_failure');
      expect(res.code).toBe(0);
      expect(res.out).toContain(`Exported 4 rows to ${out}.`);
      const csv = fs.readFileSync(out, 'utf8');
      const lines = csv.trim().split('\r\n');
      expect(lines[0]).toBe('seq,occurred_at,event_type,success,user_id,subject_hash,ip,user_agent,details,row_hash');
      expect(lines).toHaveLength(5); // header + 4 login_failure rows (seq 1, 4, 7, 10)
      expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"",""Click me"")"`);
      expect(csv).not.toMatch(/,=HYPERLINK/);

      const [event] = await db('auth_logs').where({ event_type: 'audit_exported' });
      expect(event.details).toMatchObject({ actor: 'cli', rows: 4, filters: 'type=login_failure' });
    });

    test('export is refused (and no file kept) if the export cannot be recorded (fail closed)', async () => {
      await seedChain(5);
      const out = path.join(os.tmpdir(), `cg-export-refused-${process.pid}.csv`);
      const res = await withAuditWritesFailing(db, () => audit('export', '--out', out));
      expect(res.code).toBe(1);
      expect(fs.existsSync(out)).toBe(false);
    });
  });

  describe('policy, role and permission changes are logged with history (FR-Z5)', () => {
    test('policy set: needs --confirm; then changes the live policy, writes policy_history and an audit event', async () => {
      const dry = await admin('policy', 'set', 'max_attempts=3');
      expect(dry.code).toBe(2);
      expect((await db('policies').first()).max_attempts).toBe(5);

      const res = await admin('policy', 'set', 'max_attempts=3', 'lockout_minutes=20', '--confirm');
      expect(res.code).toBe(0);
      expect(res.out).toContain('Policy changed: max_attempts 5 -> 3, lockout_minutes 15 -> 20.');
      expect(await db('policies').first()).toMatchObject({ max_attempts: 3, lockout_minutes: 20 });

      const [history] = await db('policy_history');
      expect(history).toMatchObject({
        subject: 'policy', actor: 'cli', changed_fields: ['max_attempts', 'lockout_minutes'],
        old_value: { max_attempts: 5, lockout_minutes: 15 }, new_value: { max_attempts: 3, lockout_minutes: 20 },
      });
      const [event] = await db('auth_logs').where({ event_type: 'policy_changed' });
      expect(event.details).toEqual({ actor: 'cli', fields: 'max_attempts,lockout_minutes' });

      // Applies without a restart: a running app now locks after 3 failures.
      const { post } = await csrfAgent(buildRealApp({ db, redis }));
      for (let i = 0; i < 3; i += 1) await post('/auth/login', { identifier: REGISTERED[0].matric_no, password: 'Wrong-Password-1!' });
      expect((await db('users').where({ matric_or_staff_id: REGISTERED[0].matric_no }).first()).locked_until).not.toBeNull();

      expect((await admin('history')).out).toContain('policy');
    });

    test('policy set refuses require_2fa_admin, unknown fields and out-of-range values; nothing is recorded', async () => {
      expect((await admin('policy', 'set', 'require_2fa_admin=false', '--confirm')).out).toContain('"require_2fa_admin" cannot be changed');
      const out = await admin('policy', 'set', 'max_attempts=99', '--confirm');
      expect(out.code).toBe(1);
      expect(out.out).toContain('value out of the allowed range');
      expect(await db('policy_history')).toHaveLength(0);
      expect(await db('auth_logs').where({ event_type: 'policy_changed' })).toHaveLength(0);
      expect((await db('policies').first()).max_attempts).toBe(5);
    });

    test('FAIL CLOSED: if the audit event cannot be written, the policy does not change', async () => {
      const res = await withAuditWritesFailing(db, () => admin('policy', 'set', 'max_attempts=3', '--confirm'));
      expect(res.code).toBe(1);
      expect((await db('policies').first()).max_attempts).toBe(5);
      expect(await db('policy_history')).toHaveLength(0);
    });

    test('role set: changes the role, records old and new, and signs the user out (sessions revoked)', async () => {
      const { post, agent } = await csrfAgent(buildRealApp({ db, redis }));
      await post('/auth/login', { identifier: REGISTERED[0].matric_no, password: PASSWORDS.student });
      expect((await agent.get('/account/security')).status).toBe(200);

      const res = await admin('role', 'set', REGISTERED[0].matric_no, 'staff', '--confirm');
      expect(res.code).toBe(0);
      expect(res.out).toContain('student -> staff');
      const [history] = await db('policy_history').where({ subject: 'user_role' });
      expect(history).toMatchObject({ old_value: { role: 'student' }, new_value: { role: 'staff' } });
      const [event] = await db('auth_logs').where({ event_type: 'role_changed' });
      expect(event.details).toEqual({ actor: 'cli', from: 'student', to: 'staff' });
      // The old token carried role "student": it must stop working at once.
      expect((await agent.get('/account/security')).status).toBe(302);
      const [revoked] = await db('auth_logs').where({ event_type: 'sessions_revoked' });
      expect(revoked.details).toEqual({ reason: 'role_changed', count: 1, actor: 'cli' });
    });

    test('perm grant/revoke: recorded, and a running app reloads its permission map without a restart', async () => {
      const permissions = createPermissions({ db, redis, logger: createLogger({ level: 'silent' }) });
      trackForTeardown(permissions, () => permissions.stop());
      await permissions.start();
      expect(await permissions.can('guest', 'fees')).toBe(false);

      expect((await admin('perm', 'grant', 'guest', 'fees')).code).toBe(2); // needs --confirm
      const res = await admin('perm', 'grant', 'guest', 'fees', '--confirm');
      expect(res.code).toBe(0);
      expect(res.out).toContain('Permission granted: guest fees (running app processes reload it now).');
      await waitFor(() => permissions.can('guest', 'fees'));

      await admin('perm', 'revoke', 'guest', 'fees', '--confirm');
      await waitFor(async () => !(await permissions.can('guest', 'fees')));

      const history = await db('policy_history').where({ subject: 'role_permission' }).orderBy('id');
      expect(history.map((h) => h.new_value)).toEqual([{ granted: true }, { granted: false }]);
      const events = await db('auth_logs').where({ event_type: 'permission_changed' }).orderBy('seq');
      expect(events.map((e) => e.details.action)).toEqual(['grant', 'revoke']);
      expect((await admin('perm', 'list')).out).not.toMatch(/guest\s+fees/);
    });

    test('the whole chain still verifies after all of these admin actions', async () => {
      await admin('policy', 'set', 'max_attempts=4', '--confirm');
      await admin('perm', 'grant', 'staff', 'admin_console', '--confirm');
      const res = await audit('verify');
      expect(res.code).toBe(0);
      expect(res.out).toContain('OK: the chain is intact');
    });
  });
});
