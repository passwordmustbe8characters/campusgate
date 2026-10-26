'use strict';

// Phase 7 (FR-M3): a demo invoice can be marked paid after a step-up code.
// DEMONSTRATION ONLY: no money moves and no bank details exist anywhere.
exports.up = async (knex) => {
  await knex.raw('ALTER TABLE demo_invoices ADD COLUMN paid_at timestamptz');
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE demo_invoices DROP COLUMN paid_at');
};
