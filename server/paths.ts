import { realpath, stat, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
export class Projects {
  constructor(public roots: string[]) {}
  async init() {
    this.roots = await Promise.all(
      this.roots.map(async (r) => {
        await mkdir(r, { recursive: true });
        return realpath(r);
      }),
    );
  }
  contains(p: string) {
    return this.roots.some((r) => p === r || p.startsWith(r + path.sep));
  }
  async resolve(p: string) {
    if (!path.isAbsolute(p)) throw new Error('请选择绝对目录路径');
    const actual = await realpath(p);
    if (!this.contains(actual)) throw new Error('目录不在允许的项目范围内');
    if (!(await stat(actual)).isDirectory()) throw new Error('该路径不是目录');
    return actual;
  }
  async list(p?: string, showHidden = false) {
    if (!p)
      return {
        path: null,
        parent: null,
        entries: this.roots.map((r) => ({ name: path.basename(r), path: r })),
      };
    const current = await this.resolve(p);
    const dirs = await readdir(current, { withFileTypes: true });
    const entries = [];
    for (const d of dirs) {
      if (!showHidden && d.name.startsWith('.')) continue;
      if (d.isDirectory() || d.isSymbolicLink())
        try {
          const target = await this.resolve(path.join(current, d.name));
          entries.push({ name: d.name, path: target });
        } catch {}
    }
    return {
      path: current,
      parent: this.roots.includes(current) ? null : path.dirname(current),
      entries: entries.sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
  async create(parent: string, name: string) {
    if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,79}$/u.test(name) || name.includes('..'))
      throw new Error('目录名称只支持文字、数字、空格、点、下划线和短横线');
    const base = await this.resolve(parent);
    const target = path.join(base, name);
    await mkdir(target);
    return this.resolve(target);
  }
}
