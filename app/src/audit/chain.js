'use strict';

const crypto = require('node:crypto');

// Any constant works; it only has to be the same everywhere the chain is extended.
const CHAIN_LOCK_ID = 4242301;
const GENESIS = 'genesis';
const ANCHOR_KEY = 'cg:audit:head';

/** JSON with object keys sorted at every level, so jsonb round-trips hash the same. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

const iso = (t) => (t instanceof Date ? t.toISOString() : new Date(t).toISOString());
const idOrNull = (v) => (v === null || v === undefined ? null : String(v));

/**
 * The exact fields covered by row_hash, in a fixed order. Values are normalized
 * so a row read back from PostgreSQL (bigint as string, timestamptz as Date,
 * jsonb re-ordered) hashes the same as when it was written.
 */
function canonicalRow(row) {
  return canonicalJson([
    String(row.seq),
    String(row.event_id),
    iso(row.occurred_at),
    row.event_type,
    idOrNull(row.user_id),
    row.subject_hash ?? null,
    row.ip ?? null,
    row.user_agent ?? null,
    Boolean(row.success),
    row.details || {},
  ]);
}

function rowHash(key, prevHash, row) {
  return crypto.createHmac('sha256', key).update(`${prevHash}\n${canonicalRow(row)}`).digest('base64url');
}

/**
 * Append events to the chain inside the caller's transaction.
 * - The advisory lock serializes every writer (queue writer, sync mode, critical
 *   events), so the chain can never fork.
 * - Events whose event_id is already stored are skipped: writing is idempotent,
 *   so a re-delivered event is never duplicated.
 * Returns { written, skipped, head: { seq, hash } }.
 */
async function appendEvents(trx, key, events) {
  await trx.raw('SELECT pg_advisory_xact_lock(?)', [CHAIN_LOCK_ID]);
  const last = await trx('auth_logs').orderBy('seq', 'desc').first('seq', 'row_hash');
  let seq = last ? Number(last.seq) : 0;
  let prev = last ? last.row_hash : GENESIS;

  const ids = events.map((e) => e.event_id);
  const existing = new Set(ids.length ? await trx('auth_logs').whereIn('event_id', ids).pluck('event_id') : []);

  const rows = [];
  for (const event of events) {
    if (existing.has(event.event_id)) continue;
    existing.add(event.event_id); // also de-duplicates within one batch
    seq += 1;
    const row = { ...event, seq, prev_hash: prev };
    row.row_hash = rowHash(key, prev, row);
    prev = row.row_hash;
    rows.push(row);
  }
  for (let i = 0; i < rows.length; i += 1000) {
    await trx('auth_logs').insert(rows.slice(i, i + 1000).map((r) => ({ ...r, details: JSON.stringify(r.details || {}) })));
  }
  return { written: rows.length, skipped: events.length - rows.length, head: { seq, hash: prev } };
}

// Move the outside-the-database anchor forward only (concurrent writers may finish out of order).
const ANCHOR_SCRIPT = `
local cur = redis.call('HGET', KEYS[1], 'seq')
if (not cur) or tonumber(cur) < tonumber(ARGV[1]) then
  redis.call('HSET', KEYS[1], 'seq', ARGV[1], 'hash', ARGV[2], 'at', ARGV[3])
  return 1
end
return 0`;

/**
 * Record the latest chain position outside the database (FR-L3 tail protection):
 * deleting the newest rows cannot be detected from the chain alone.
 */
async function updateAnchor(redis, head) {
  if (!head || !head.seq) return;
  await redis.eval(ANCHOR_SCRIPT, 1, ANCHOR_KEY, head.seq, head.hash, new Date().toISOString());
}

async function readAnchor(redis) {
  const data = await redis.hgetall(ANCHOR_KEY);
  return data && data.seq ? { seq: Number(data.seq), hash: data.hash, at: data.at } : null;
}

/**
 * Recompute the chain in seq order, streaming in pages (constant memory).
 * Reports the FIRST problem found:
 *   gap        a seq number is missing (row deleted)
 *   prev_hash  a row does not link to the row before it (deleted or reordered)
 *   row_hash   a row's content does not match its hash (edited, or wrong key)
 *   tail       the database ends before the recorded anchor (newest rows deleted)
 *   anchor     the row at the anchor's position is not the one recorded (re-forged tail)
 */
async function verifyChain(db, key, { anchor = null, pageSize = 5000, onProgress } = {}) {
  let expectedSeq = 1;
  let prev = GENESIS;
  let checked = 0;
  let lastSeq = 0;
  let anchorRowHash = null; // hash of the row at the anchor's seq, if we pass it

  for (;;) {
    const page = await db('auth_logs').where('seq', '>=', expectedSeq).orderBy('seq').limit(pageSize);
    if (page.length === 0) break;
    for (const row of page) {
      const seq = Number(row.seq);
      if (seq !== expectedSeq) return { ok: false, checked, firstBadSeq: expectedSeq, reason: 'gap', detail: `seq ${expectedSeq} is missing (next is ${seq})` };
      if (row.prev_hash !== prev) return { ok: false, checked, firstBadSeq: seq, reason: 'prev_hash', detail: 'row does not link to the previous row' };
      const recomputed = rowHash(key, prev, row);
      if (recomputed !== row.row_hash) return { ok: false, checked, firstBadSeq: seq, reason: 'row_hash', detail: 'row content does not match its hash' };
      prev = row.row_hash;
      if (anchor && seq === anchor.seq) anchorRowHash = row.row_hash;
      lastSeq = seq;
      expectedSeq += 1;
      checked += 1;
    }
    if (onProgress) onProgress(checked);
  }

  if (anchor && anchor.seq > lastSeq) {
    return { ok: false, checked, firstBadSeq: lastSeq + 1, reason: 'tail', detail: `anchor says seq ${anchor.seq} exists; database ends at ${lastSeq}` };
  }
  if (anchor && anchorRowHash !== anchor.hash) {
    // The row the anchor points at was replaced (e.g. newest rows deleted and re-forged).
    return { ok: false, checked, firstBadSeq: anchor.seq, reason: 'anchor', detail: `row ${anchor.seq} does not match the recorded anchor` };
  }
  return { ok: true, checked, lastSeq, headHash: lastSeq ? prev : null };
}

module.exports = {
  appendEvents, verifyChain, updateAnchor, readAnchor, rowHash, canonicalRow, canonicalJson,
  CHAIN_LOCK_ID, GENESIS, ANCHOR_KEY,
};
