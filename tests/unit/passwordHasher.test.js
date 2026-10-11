'use strict';

const { createHasher, costOf } = require('../../app/src/services/passwordHasher');

describe('password hasher (FR-A4)', () => {
  test('hashes with the configured cost and verifies', async () => {
    const hasher = createHasher(5);
    const hash = await hasher.hash('Kettle-Mango-42');
    expect(hash).toMatch(/^\$2b\$05\$/);
    expect(costOf(hash)).toBe(5);
    await expect(hasher.compare('Kettle-Mango-42', hash)).resolves.toBe(true);
    await expect(hasher.compare('wrong', hash)).resolves.toBe(false);
  });

  test('never stores the plain password in the hash', async () => {
    const hash = await createHasher(4).hash('Kettle-Mango-42');
    expect(hash).not.toContain('Kettle-Mango-42');
  });

  test.each([4, 6])('dummy hash uses the same cost as real hashes (cost %i)', async (cost) => {
    const hasher = createHasher(cost);
    expect(costOf(await hasher.dummyHash())).toBe(cost);
    expect(costOf(await hasher.dummyHash())).toBe(costOf(await hasher.hash('x')));
  });

  test('dummy hash is computed once and reused', async () => {
    const hasher = createHasher(4);
    expect(await hasher.dummyHash()).toBe(await hasher.dummyHash());
  });
});
