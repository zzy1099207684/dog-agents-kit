import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, mkdtempSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DAK_CLI = join(process.cwd(), 'dist', 'cli.js');
const TMP_PREFIX = 'dak-e2e-';

// dist/cli.js 必须先 build；缺失时给出明确提示而非一堆 ENOENT
if (!existsSync(DAK_CLI)) {
  throw new Error('dist/cli.js not found; run npm run build first');
}

function makeStore(): string {
  const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  const store = join(root, 'store');
  mkdirSync(store, { recursive: true });
  return store;
}

function makeHome(): string {
  const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  const home = join(root, 'home');
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(join(home, '.claude'), { recursive: true });
  return home;
}

function exec(store: string, home: string, args: string[]): string {
  return execFileSync(process.execPath, [DAK_CLI, ...args], {
    env: { ...process.env, HOME: home },
    encoding: 'utf-8',
  });
}

describe('dak e2e', () => {
  it('init --store', () => {
    const store = makeStore();
    const home = makeHome();
    try {
      const out = exec(store, home, ['init', '--store', store]);
      expect(out).toContain('Initialized');
      const config = JSON.parse(readFileSync(join(store, 'dak.config.json'), 'utf-8'));
      expect(config.store).toBe(store);
    } finally {
      rmSync(join(store, '..'), { recursive: true, force: true });
      rmSync(join(home, '..'), { recursive: true, force: true });
    }
  });

  it('写入 skills/foo 后 link codex 并验证内容', () => {
    const store = makeStore();
    const home = makeHome();
    const codexSkills = join(home, '.codex', 'skills');
    mkdirSync(codexSkills, { recursive: true });
    try {
      exec(store, home, ['init', '--store', store]);
      writeFileSync(join(store, 'skills', 'foo'), 'hello');
      const out = exec(store, home, ['link', 'codex', '--store', store, '--on-conflict', 'skip']);
      expect(out).toContain('created');
      expect(readFileSync(join(codexSkills, 'foo'), 'utf-8')).toBe('hello');
    } finally {
      rmSync(join(store, '..'), { recursive: true, force: true });
      rmSync(join(home, '..'), { recursive: true, force: true });
    }
  });

  it('删除 foo 新增 bar 后 update', () => {
    const store = makeStore();
    const home = makeHome();
    const codexSkills = join(home, '.codex', 'skills');
    mkdirSync(codexSkills, { recursive: true });
    try {
      exec(store, home, ['init', '--store', store]);
      writeFileSync(join(store, 'skills', 'foo'), 'hello');
      exec(store, home, ['link', 'codex', '--store', store, '--on-conflict', 'skip']);
      rmSync(join(store, 'skills', 'foo'));
      writeFileSync(join(store, 'skills', 'bar'), 'world');
      const out = exec(store, home, ['update', '--store', store]);
      expect(out).toContain('deleted');
      expect(out).toContain('created');
      expect(readFileSync(join(codexSkills, 'bar'), 'utf-8')).toBe('world');
    } finally {
      rmSync(join(store, '..'), { recursive: true, force: true });
      rmSync(join(home, '..'), { recursive: true, force: true });
    }
  });

  it('unlink codex', () => {
    const store = makeStore();
    const home = makeHome();
    const codexSkills = join(home, '.codex', 'skills');
    mkdirSync(codexSkills, { recursive: true });
    try {
      exec(store, home, ['init', '--store', store]);
      writeFileSync(join(store, 'skills', 'foo'), 'x');
      exec(store, home, ['link', 'codex', '--store', store, '--on-conflict', 'skip']);
      const out = exec(store, home, ['unlink', 'codex', '--store', store]);
      expect(out).toContain('deleted');
      expect(readFileSync(join(store, 'skills', 'foo'), 'utf-8')).toBe('x');
    } finally {
      rmSync(join(store, '..'), { recursive: true, force: true });
      rmSync(join(home, '..'), { recursive: true, force: true });
    }
  });

  it('--on-conflict backup 真实文件', () => {
    const store = makeStore();
    const home = makeHome();
    const codexSkills = join(home, '.codex', 'skills');
    mkdirSync(codexSkills, { recursive: true });
    try {
      exec(store, home, ['init', '--store', store]);
      writeFileSync(join(store, 'skills', 'bar'), 'store-file');
      // 创建真实文件（非 symlink）
      writeFileSync(join(codexSkills, 'bar'), 'real-file');
      const out = exec(store, home, ['link', 'codex', '--store', store, '--on-conflict', 'backup']);
      expect(out).toContain('backed-up');
      expect(readFileSync(join(codexSkills, 'bar'), 'utf-8')).toBe('store-file');
    } finally {
      rmSync(join(store, '..'), { recursive: true, force: true });
      rmSync(join(home, '..'), { recursive: true, force: true });
    }
  });

  it('非交互环境默认 skip', () => {
    const store = makeStore();
    const home = makeHome();
    const codexSkills = join(home, '.codex', 'skills');
    mkdirSync(codexSkills, { recursive: true });
    try {
      exec(store, home, ['init', '--store', store]);
      writeFileSync(join(codexSkills, 'baz'), 'existing');
      writeFileSync(join(store, 'skills', 'baz'), 'new');
      const out = exec(store, home, ['link', 'codex', '--store', store]);
      expect(out).toContain('conflict');
      expect(readFileSync(join(codexSkills, 'baz'), 'utf-8')).toBe('existing');
    } finally {
      rmSync(join(store, '..'), { recursive: true, force: true });
      rmSync(join(home, '..'), { recursive: true, force: true });
    }
  });

  it('--store ~/x 按 home 展开而非字面 ~', () => {
    const home = makeHome();
    const storeViaTilde = '~/dak-tilde-store';
    const resolvedStore = join(home, 'dak-tilde-store');
    try {
      const out = exec(resolvedStore, home, ['init', '--store', storeViaTilde]);
      expect(out).toContain('Initialized dak store at ' + resolvedStore);
      // 目录建在 home 下，不在 cwd 下创建字面 ~
      expect(existsSync(resolvedStore)).toBe(true);
      expect(existsSync(join(process.cwd(), '~'))).toBe(false);
      const config = JSON.parse(readFileSync(join(resolvedStore, 'dak.config.json'), 'utf-8'));
      expect(config.store).toBe(resolvedStore);
    } finally {
      rmSync(join(home, '..'), { recursive: true, force: true });
      // 兜底清理可能误建的字面 ~ 目录
      rmSync(join(process.cwd(), '~'), { recursive: true, force: true });
    }
  });
});
