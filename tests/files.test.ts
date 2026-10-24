import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Projects } from '../server/paths.js';
import { createDownloadPolicy, FileBrowser, FileAccessError } from '../server/files.js';

test('file browser lists and downloads only permitted workspace files', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-mobile-files-'));
  try {
    const workspace = path.join(home, 'ideas');
    const other = path.join(home, 'other');
    const hiddenDirectory = path.join(workspace, '.private');
    const blockedDirectory = path.join(workspace, 'excluded');
    await mkdir(workspace);
    await mkdir(other);
    await mkdir(hiddenDirectory);
    await mkdir(blockedDirectory);
    await writeFile(path.join(workspace, '报告.txt'), '实验结果');
    await writeFile(path.join(workspace, '.secret.txt'), 'secret');
    await writeFile(path.join(hiddenDirectory, 'inside.txt'), 'secret');
    await writeFile(path.join(blockedDirectory, 'inside.txt'), 'blocked');
    await writeFile(path.join(other, 'outside.txt'), 'outside');
    await symlink('.secret.txt', path.join(workspace, 'visible-secret-link'));
    await symlink('.private', path.join(workspace, 'visible-private-link'));
    await symlink(path.join(other, 'outside.txt'), path.join(workspace, 'outside-link'));
    await symlink('报告.txt', path.join(workspace, 'visible-report-link'));
    await symlink(workspace, path.join(home, '.hidden-workspace-link'));
    const projects = new Projects([home]);
    await projects.init();
    const browser = new FileBrowser(projects, createDownloadPolicy(home, [blockedDirectory]));
    const names = (await browser.list(workspace)).entries.map((entry) => entry.name);
    assert.deepEqual(names, ['visible-report-link', '报告.txt']);
    assert.equal((await browser.download(workspace, '报告.txt')).name, '报告.txt');
    assert.equal(
      (await browser.download(workspace, 'visible-report-link')).name,
      'visible-report-link',
    );
    for (const denied of [
      '.secret.txt',
      '.private/inside.txt',
      'visible-secret-link',
      'visible-private-link/inside.txt',
      'excluded/inside.txt',
      'outside-link',
    ]) {
      await assert.rejects(
        browser.download(workspace, denied),
        (error: unknown) => error instanceof FileAccessError && error.status === 403,
      );
    }
    await assert.rejects(
      browser.list(workspace, '.private'),
      (error: unknown) => error instanceof FileAccessError && error.status === 403,
    );
    await assert.rejects(
      browser.list(path.join(workspace, '.private')),
      (error: unknown) => error instanceof FileAccessError && error.status === 403,
    );
    await assert.rejects(
      browser.download(path.join(home, '.hidden-workspace-link'), '报告.txt'),
      (error: unknown) => error instanceof FileAccessError && error.status === 403,
    );
    for (const invalid of ['../other/outside.txt', '/etc/passwd', './报告.txt']) {
      await assert.rejects(browser.download(workspace, invalid));
    }
    await assert.rejects(browser.download(workspace, 'excluded'));
    await assert.rejects(browser.list(workspace, '', '-1'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('download rules can be extended with another denied path', () => {
  const home = '/home/example';
  const policy = createDownloadPolicy(home, [
    '/tmp/private',
    '/home/example/ideas/output/internal.txt',
  ]);
  policy.assertAllowed('/home/example/ideas/output/chart.png');
  policy.assertAllowed('/tmp/public/chart.png');
  for (const denied of [
    '/home/example/.codex/auth.json',
    '/home/example/ideas/.cache/result.png',
    '/tmp/private/report.pdf',
    '/home/example/ideas/output/internal.txt',
  ]) {
    assert.throws(() => policy.assertAllowed(denied), FileAccessError);
  }
  assert.throws(() => createDownloadPolicy(home, ['relative/path']));
});

test('large directories can be browsed in pages without exposing hidden entries', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-mobile-file-pages-'));
  try {
    await writeFile(path.join(home, '.hidden.txt'), 'secret');
    await Promise.all(
      Array.from({ length: 105 }, (_, index) =>
        writeFile(path.join(home, `file-${String(index).padStart(3, '0')}.txt`), String(index)),
      ),
    );
    const projects = new Projects([home]);
    await projects.init();
    const browser = new FileBrowser(projects, createDownloadPolicy(home));
    const first = await browser.list(home);
    assert.equal(first.entries.length, 100);
    assert.ok(first.nextCursor);
    const second = await browser.list(home, '', first.nextCursor);
    assert.equal(second.entries.length, 5);
    assert.equal(second.nextCursor, null);
    assert.equal(
      new Set([...first.entries, ...second.entries].map((entry) => entry.name)).size,
      105,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
