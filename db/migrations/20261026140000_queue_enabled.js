'use strict';

// Phase 5 (FR-P2, FR-P3): switch the waiting room on or off without a restart,
// so the same load can be measured with admission control off (baseline) and on.
exports.up = async (knex) => {
  await knex.raw('ALTER TABLE policies ADD COLUMN queue_enabled boolean NOT NULL DEFAULT true');
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE policies DROP COLUMN queue_enabled');
};
