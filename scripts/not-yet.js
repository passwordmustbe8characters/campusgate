'use strict';

// Placeholder for npm scripts whose implementation belongs to a later phase.
// Exits non-zero so nobody mistakes it for a real result.
const [name, phase] = process.argv.slice(2);
console.error(`"npm run ${name}" is not implemented yet (planned for Phase ${phase}).`);
process.exit(1);
