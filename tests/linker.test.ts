import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { classifyTarget, linkItem, safeDeleteManagedLink } from '../src/linker.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync, readdir } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TMP_PREFIX = 'dak-linker-';

function makeStore(tmp: string) {
  const store = join(tmp, 'store');
  mkdirSync(join(store, 'skills'), { recursive: true });
  mkdirSync(join(store, 'hooks'), { recursive: true });
  mkdirSync(join(store, 'agents'), { recursive: true });
  return store;
}

function makeTarget(tmp: string, name: string) {
  const target = join(tmp, name);
  mkdirSync(target, { recursive: true });
  return target;
}

describe('classifyTarget', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true });
  });

  it('missing 当 target 不存在', async () => {
    const result = await classifyTarget(join(tmp, 'no-such-dir', 'item'), '/abs/source');
    expect(result).toBe('missing');
  });

  it('linked 当 symlink 指向 expected source', async () => {
    const source = join(tmp, 'store', 'skills', 'foo');
    mkdirSync(join(tmp, 'store', 'skills'), { recursive: true });
    writeFileSync(source, 'x');
    const targetDir = join(tmp, 'codex', 'skills');
    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, 'foo');
    symlinkSync(source, targetPath);
    const result = await classifyTarget(targetPath, source);
    expect(result).toBe('linked');
  });

  it('conflict 当 target 是真实文件', async () => {
    const targetPath = join(tmp, 'real-file');
    writeFileSync(targetPath, 'x');
    const result = await classifyTarget(targetPath, '/abs/source');
    expect(result).toBe('conflict');
  });

  it('broken 当 symlink 指向不存在目标', async () => {
    const targetPath = join(tmp, 'broken-link');
    symlinkSync('/no/such/target', targetPath);
    const result = await classifyTarget(targetPath, '/abs/source');
    expect(result).toBe('broken');
  });
});

describe('linkItem', () => {
  let tmp: string;
  let store: string;
  let targetRoot: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    store = makeStore(tmp);
    targetRoot = makeTarget(tmp, 'codex');
    mkdirSync(join(targetRoot, 'skills'), { recursive: true });
    writeFileSync(join(store, 'skills', 'foo'), 'x');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true });
  });

  const now = new Date('2025-01-01T00:00:00.000Z');

  it('missing 时创建 symlink', async () => {
    const outcome = await linkItem({
      sourcePath: join(store, 'skills', 'foo'),
      targetPath: join(targetRoot, 'skills', 'foo'),
      resourceType: 'skills',
      itemName: 'foo',
      storePath: store,
      policy: 'skip',
      now,
    });
    expect(outcome.status).toBe('created');
    expect(readFileSync(join(targetRoot, 'skills', 'foo'), 'utf-8')).toBe('x');
  });

  it('linked 时直接返回 record', async () => {
    const targetPath = join(targetRoot, 'skills', 'foo');
    symlinkSync(join(store, 'skills', 'foo'), targetPath);
    const outcome = await linkItem({
      sourcePath: join(store, 'skills', 'foo'),
      targetPath,
      resourceType: 'skills',
      itemName: 'foo',
      storePath: store,
      policy: 'skip',
      now,
    });
    expect(outcome.status).toBe('linked');
    expect(outcome.record).toBeDefined();
    expect(outcome.record!.source).toBe(join(store, 'skills', 'foo'));
  });

  it('conflict 时 skip 返回 conflict', async () => {
    writeFileSync(join(targetRoot, 'skills', 'foo'), 'old');
    const outcome = await linkItem({
      sourcePath: join(store, 'skills', 'foo'),
      targetPath: join(targetRoot, 'skills', 'foo'),
      resourceType: 'skills',
      itemName: 'foo',
      storePath: store,
      policy: 'skip',
      now,
    });
    expect(outcome.status).toBe('conflict');
    expect(readFileSync(join(targetRoot, 'skills', 'foo'), 'utf-8')).toBe('old');
  });

  it('backup 移动旧内容后创建 symlink', async () => {
    writeFileSync(join(targetRoot, 'skills', 'foo'), 'old');
    const outcome = await linkItem({
      sourcePath: join(store, 'skills', 'foo'),
      targetPath: join(targetRoot, 'skills', 'foo'),
      resourceType: 'skills',
      itemName: 'foo',
      storePath: store,
      policy: 'backup',
      now,
    });
    expect(outcome.status).toBe('backed-up');
    // symlink 已创建
    const stat = await import('node:fs/promises').then(m => m.stat(join(targetRoot, 'skills', 'foo')));
    expect(stat).toBeDefined();
    // 备份存在，时间戳格式 YYYYMMDDTHHmmssSSSZ
    const ts = now.toISOString().replace(/[-:]/g, '').replace('.', '');
    const backupPath = join(targetRoot, '.dak-backup', ts, 'skills', 'foo');
    expect(readFileSync(backupPath, 'utf-8')).toBe('old');
  });

  it('overwrite 删除旧内容后创建 symlink', async () => {
    writeFileSync(join(targetRoot, 'skills', 'foo'), 'old');
    const outcome = await linkItem({
      sourcePath: join(store, 'skills', 'foo'),
      targetPath: join(targetRoot, 'skills', 'foo'),
      resourceType: 'skills',
      itemName: 'foo',
      storePath: store,
      policy: 'overwrite',
      now,
    });
    expect(outcome.status).toBe('overwritten');
    expect(readFileSync(join(targetRoot, 'skills', 'foo'), 'utf-8')).toBe('x');
  });

  it('broken symlink 视为 conflict；overwrite 可替换', async () => {
    const targetPath = join(targetRoot, 'skills', 'foo');
    symlinkSync('/no/target', targetPath);
    const outcome = await linkItem({
      sourcePath: join(store, 'skills', 'foo'),
      targetPath,
      resourceType: 'skills',
      itemName: 'foo',
      storePath: store,
      policy: 'overwrite',
      now,
    });
    expect(outcome.status).toBe('overwritten');
    expect(readFileSync(targetPath, 'utf-8')).toBe('x');
  });
});

describe('safeDeleteManagedLink', () => {
  let tmp: string;
  let store: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    store = makeStore(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true });
  });

  it('删除正确的 symlink 返回 deleted', async () => {
    const source = join(store, 'skills', 'foo');
    writeFileSync(source, 'x');
    const targetDir = join(tmp, 'codex', 'skills');
    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, 'foo');
    symlinkSync(source, targetPath);
    const record = { source, target: targetPath, linkedAt: new Date().toISOString() };
    const result = await safeDeleteManagedLink(record, store);
    expect(result).toBe('deleted');
  });

  it('target 不存在返回 missing', async () => {
    const record = {
      source: join(store, 'skills', 'foo'),
      target: join(tmp, 'codex', 'skills', 'foo'),
      linkedAt: new Date().toISOString(),
    };
    const result = await safeDeleteManagedLink(record, store);
    expect(result).toBe('missing');
  });

  it('真实文件不删除，返回 conflict', async () => {
    const targetDir = join(tmp, 'codex', 'skills');
    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, 'foo');
    writeFileSync(targetPath, 'x');
    const record = {
      source: join(store, 'skills', 'foo'),
      target: targetPath,
      linkedAt: new Date().toISOString(),
    };
    const result = await safeDeleteManagedLink(record, store);
    expect(result).toBe('conflict');
    expect(require('node:fs').existsSync(targetPath)).toBe(true);
  });

  it('指向其他 store 的 symlink 不删除，返回 conflict', async () => {
    const otherStore = join(tmp, 'other-store');
    mkdirSync(join(otherStore, 'skills'), { recursive: true });
    const source = join(otherStore, 'skills', 'foo');
    writeFileSync(source, 'x');
    const targetDir = join(tmp, 'codex', 'skills');
    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, 'foo');
    symlinkSync(source, targetPath);
    const record = { source, target: targetPath, linkedAt: new Date().toISOString() };
    const result = await safeDeleteManagedLink(record, store);
    expect(result).toBe('conflict');
  });

  it('symlink 改指向同一 store 另一个 item，返回 conflict', async () => {
    const source1 = join(store, 'skills', 'foo');
    const source2 = join(store, 'skills', 'bar');
    writeFileSync(source1, 'x');
    writeFileSync(source2, 'x');
    const targetDir = join(tmp, 'codex', 'skills');
    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, 'foo');
    symlinkSync(source1, targetPath);
    // 用户改成指向 bar
    rmSync(targetPath);
    symlinkSync(source2, targetPath);
    const record = { source: source1, target: targetPath, linkedAt: new Date().toISOString() };
    const result = await safeDeleteManagedLink(record, store);
    expect(result).toBe('conflict');
  });

  it('断链 symlink（source 已删）应被删除，返回 deleted', async () => {
    const source = join(store, 'skills', 'foo');
    writeFileSync(source, 'x');
    const targetDir = join(tmp, 'codex', 'skills');
    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, 'foo');
    symlinkSync(source, targetPath);
    // source 被删 → target 成断链 symlink
    rmSync(source);
    const record = { source, target: targetPath, linkedAt: new Date().toISOString() };
    const result = await safeDeleteManagedLink(record, store);
    expect(result).toBe('deleted');
    // 断链 symlink 真的被 unlink，不再存在于磁盘
    const { lstatSync } = await import('node:fs');
    expect(() => lstatSync(targetPath)).toThrow();
  });
});
