import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Projects } from './paths.js';

function contains(root: string, target: string) {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
  );
}

export class FileAccessError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export type DownloadDenyRule = {
  id: string;
  denies: (absolutePath: string) => boolean;
};

export class DownloadPolicy {
  constructor(public rules: DownloadDenyRule[]) {}

  assertAllowed(absolutePath: string) {
    if (this.rules.some((rule) => rule.denies(absolutePath))) {
      throw new FileAccessError('此路径不允许下载', 403);
    }
  }
}

export function createDownloadPolicy(home = os.homedir(), additionalDeniedPaths: string[] = []) {
  const homePath = path.resolve(home);
  const rules: DownloadDenyRule[] = [
    {
      id: 'hidden-home-entries',
      denies: (candidate) =>
        contains(homePath, candidate) &&
        path
          .relative(homePath, candidate)
          .split(path.sep)
          .some((part) => part.startsWith('.')),
    },
  ];
  for (const denied of additionalDeniedPaths) {
    if (!path.isAbsolute(denied)) {
      throw new Error('FILE_DOWNLOAD_DENY_PATHS 只接受绝对路径');
    }
    const blocked = path.resolve(denied);
    rules.push({
      id: `path:${blocked}`,
      denies: (candidate) => contains(blocked, candidate),
    });
  }
  return new DownloadPolicy(rules);
}

function parseRelative(relative: string) {
  if (!relative) return '';
  if (
    path.isAbsolute(relative) ||
    relative.includes('\0') ||
    relative.split(path.sep).some((part) => !part || part === '.' || part === '..')
  ) {
    throw new FileAccessError('文件路径无效');
  }
  return relative;
}

export class FileBrowser {
  constructor(
    private projects: Projects,
    private policy: DownloadPolicy,
  ) {}

  private async workspace(cwd: string) {
    if (path.isAbsolute(cwd)) this.policy.assertAllowed(path.resolve(cwd));
    const workspace = await this.projects.resolve(cwd);
    this.policy.assertAllowed(workspace);
    return workspace;
  }

  private async resolve(workspace: string, relative: string) {
    const requested = path.join(workspace, parseRelative(relative));
    if (!contains(workspace, requested)) throw new FileAccessError('文件不在当前工作区内', 403);
    this.policy.assertAllowed(requested);
    const actual = await realpath(requested);
    if (!contains(workspace, actual) || !this.projects.contains(actual)) {
      throw new FileAccessError('文件不在当前工作区内', 403);
    }
    this.policy.assertAllowed(actual);
    return { actual, info: await stat(actual) };
  }

  async list(cwd: string, relative = '', cursor = '') {
    const workspace = await this.workspace(cwd);
    const current = parseRelative(relative);
    const directory = await this.resolve(workspace, current);
    if (!directory.info.isDirectory()) throw new FileAccessError('该路径不是目录');
    const all = (await readdir(directory.actual)).sort((a, b) => a.localeCompare(b));
    const start = cursor === '' ? 0 : Number(cursor);
    if (!Number.isSafeInteger(start) || start < 0) throw new FileAccessError('分页位置无效');
    const entries: Array<{
      name: string;
      path: string;
      type: 'directory' | 'file';
      size: number;
      modifiedMs: number;
    }> = [];
    let index = start;
    for (; index < all.length && entries.length < 100; index++) {
      const name = all[index];
      const itemPath = current ? path.join(current, name) : name;
      try {
        const item = await this.resolve(workspace, itemPath);
        const type = item.info.isDirectory() ? 'directory' : item.info.isFile() ? 'file' : null;
        if (type)
          entries.push({
            name,
            path: itemPath,
            type,
            size: item.info.size,
            modifiedMs: item.info.mtimeMs,
          });
      } catch (error) {
        if (
          error instanceof FileAccessError ||
          (error as NodeJS.ErrnoException).code === 'ENOENT' ||
          (error as NodeJS.ErrnoException).code === 'EACCES'
        )
          continue;
        throw error;
      }
    }
    return {
      workspace,
      path: current,
      parent: current ? (path.dirname(current) === '.' ? '' : path.dirname(current)) : null,
      entries,
      nextCursor: index < all.length ? String(index) : null,
    };
  }

  async download(cwd: string, relative: string) {
    if (!relative) throw new FileAccessError('请选择文件');
    const workspace = await this.workspace(cwd);
    const file = await this.resolve(workspace, relative);
    if (!file.info.isFile()) throw new FileAccessError('该路径不是普通文件');
    return { path: file.actual, name: path.basename(relative) };
  }
}
