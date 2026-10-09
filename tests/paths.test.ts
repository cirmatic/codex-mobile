import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Projects } from '../server/paths.js';
test('project browser prevents traversal and symlink escapes, creates Unicode directories', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'codex-mobile-paths-'));
  try {
    const root = path.join(base, 'allowed');
    await mkdir(root);
    const outside = path.join(base, 'outside');
    await mkdir(outside);
    await symlink(outside, path.join(root, 'escape'));
    await mkdir(path.join(root, '.hidden'));
    const p = new Projects([root]);
    await p.init();
    assert.equal(await p.create(root, '实验 1'), path.join(root, '实验 1'));
    await assert.rejects(p.resolve(outside));
    await assert.rejects(p.resolve(path.join(root, 'escape')));
    await assert.rejects(p.create(root, '../escape'));
    await assert.rejects(p.resolve('relative'));
    assert.deepEqual(
      (await p.list(root)).entries.map((e) => e.name),
      ['实验 1'],
    );
    assert.deepEqual(
      (await p.list(root, true)).entries.map((e) => e.name),
      ['.hidden', '实验 1'],
    );
    await assert.rejects(p.create(root, '实验 1'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
