'use strict';

const { randomInt } = require('node:crypto');

// Unambiguous characters for invoice references (no 0/O/1/I/L).
const REF_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function invoiceReference(now = new Date()) {
  let suffix = '';
  for (let i = 0; i < 8; i += 1) suffix += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return `CG-${now.getUTCFullYear()}-${suffix}`;
}

/**
 * Mock school portal (FR-M1). Every page reads DEMONSTRATION data from the
 * demo_* tables; nothing here is real UNN data, and no payment is possible.
 * Authorisation is NOT done here: routes check the session token and the role
 * permission first (no database read for that), then call these for content.
 */
function createPortalService({ db }) {
  async function profile(userId) {
    return db('users').where({ id: userId }).first('matric_or_staff_id', 'level', 'faculty');
  }

  /** Fee items for the student's level (staff see the 100-level list as an example). */
  async function fees(userId) {
    const user = await profile(userId);
    const level = user && user.level ? user.level : 100;
    const items = await db('demo_fees').where({ level }).orderBy('id').select('item', 'amount_naira');
    const invoices = await db('demo_invoices').where({ user_id: userId }).orderBy('id', 'desc').limit(5)
      .select('reference', 'total_naira', 'created_at');
    const total = items.reduce((sum, i) => sum + i.amount_naira, 0);
    return { user, level, items, total, invoices };
  }

  /** Generate a demo invoice for the current fee items. No bank details, no payment. */
  async function generateInvoice(userId) {
    const { total } = await fees(userId);
    for (let attempt = 0; ; attempt += 1) {
      const reference = invoiceReference();
      try {
        await db('demo_invoices').insert({ user_id: userId, reference, total_naira: total });
        return { reference, total };
      } catch (err) {
        if (err.code !== '23505' || attempt >= 4) throw err; // unique clash: try another reference
      }
    }
  }

  async function hostels() {
    return db('demo_hostels').orderBy('hall').select('hall', 'beds_free', 'beds_total');
  }

  async function courses(userId) {
    const user = await profile(userId);
    const level = user && user.level ? user.level : 100;
    const rows = await db('demo_courses').where({ level }).orderBy('code').select('code', 'title', 'units');
    return { user, level, courses: rows, totalUnits: rows.reduce((sum, c) => sum + c.units, 0) };
  }

  return { fees, generateInvoice, hostels, courses };
}

module.exports = { createPortalService, invoiceReference, REF_ALPHABET };
