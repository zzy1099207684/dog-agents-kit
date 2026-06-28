import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  runInit,
  runList,
  runLink,
  runStatus,
  runUpdate,
  runUnlink,
} from '../src/commands.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TMP_PREFIX = 'dak-cmd-';
const FIXED_NOW = new Date('2025-06-28T10:00:00.000Z');

function makeStore(tmp: string): string {
  const store = join(tmp, 'store');
  mkdirSync(store, { recursive: true });
  return store;
}

function makeTarget(tmp: string, name: string): string {
  const target = join(tmp, name);
  mkdirSync(target, { recursive: true });
  return target;
}

function makeHome(tmp: string): string {
  const home = join(tmp, 'home');
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(join(home, '.claude'), { recursive: true });
  return home;
}

describe('runInit', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true });
  });

  it('创建 store/config/state/resource dirs', async () => {
    const storePath = join(tmp, 'init-store');
    const output = await runInit({ store: storePath, homeDir: '/tmp/home' });
    expect(output).toContain('Initialized');
    // config 存在
    const config = JSON.parse(readFileSync(join(storePath, 'dak.config.json'), 'utf-8'));
    expect(config.store).toBe(storePath);
    // state 存在
    const state = JSON.parse(readFileSync(join(storePath, '.dak-state.json'), 'utf-8'));
    expect(state.version).toBe(1);
    // resource dirs 存在
    for (const type of ['skills', 'hooks', 'agents']) {
      expect(require('node:fs').existsSync(join(storePath, type))).toBe(true);
    }
  });
});

describe('runList', () => {
  let tmp: string;
  let store: string;
  let home: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    store = makeStore(tmp);
    home = makeHome(tmp);
    await runInit({ store, homeDir: home });
    mkdirSync(join(store, 'skills'), { recursive: true });
    mkdirSync(join(store, 'skills', 'my-skill'));
    mkdirSync(join(store, 'hooks'), { recursive: true });
    mkdirSync(join(store, 'hooks', 'my-hook'));
    mkdirSync(join(store, 'agents'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true });
  });

  it('输出三类资源', async () => {
    const output = await runList({ store, homeDir: home });
    expect(output).toContain('Skills:');
    expect(output).toContain('Hooks:');
    expect(output).toContain('Agents:');
    expect(output).toContain('my-skill');
    expect(output).toContain('my-hook');
  });
});

describe('runLink', () => {
  let tmp: string;
  let store: string;
  let home: string;
  let codex: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    store = makeStore(tmp);
    home = makeHome(tmp);
    codex = join(home, '.codex'); // 使用 home 下的 .codex
    mkdirSync(join(codex, 'skills'), { recursive: true });
    mkdirSync(join(codex, 'agents'), { recursive: true });
    // 初始化 config（使用真实存在的 homeDir）
    await runInit({ store, homeDir: home });
    // 写入 store 资源
    writeFileSync(join(store, 'skills', 'foo'), 'x');
    mkdirSync(join(store, 'hooks', 'my-hook'));
    writeFileSync(join(store, 'agents', 'bar'), 'x');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true });
  });

  it('runLink(codex) 为三类资源创建 symlink 并写 state', async () => {
    const output = await runLink('codex', { store, homeDir: home, now: FIXED_NOW });
    expect(output).toContain('created');
    // symlink 已创建
    expect(readFileSync(join(codex, 'skills', 'foo'), 'utf-8')).toBe('x');
    expect(readFileSync(join(codex, 'agents', 'bar'), 'utf-8')).toBe('x');
    // state 存在
    const state = JSON.parse(readFileSync(join(store, '.dak-state.json'), 'utf-8'));
    expect(state.targets['codex'].skills['foo']).toBeDefined();
  });

  it('runLink(all) 支持配置里的所有 targets', async () => {
    const claude = join(home, '.claude');
    mkdirSync(join(claude, 'skills'), { recursive: true });
    mkdirSync(join(claude, 'agents'), { recursive: true });
    const output = await runLink('all', { store, homeDir: home, now: FIXED_NOW });
    expect(output).toContain('created');
    expect(readFileSync(join(claude, 'skills', 'foo'), 'utf-8')).toBe('x');
  });

  it('runLink(codex, resource=hooks) 只链 hooks，skills/agents 不动', async () => {
    const output = await runLink('codex', { store, homeDir: home, resource: 'hooks', now: FIXED_NOW });
    expect(output).toContain('created');
    // hooks 已链接（my-hook 是目录，target 为 symlink）
    const { lstatSync, existsSync } = await import('node:fs');
    expect(lstatSync(join(codex, 'hooks', 'my-hook')).isSymbolicLink()).toBe(true);
    // skills/agents 未被链接
    expect(existsSync(join(codex, 'skills', 'foo'))).toBe(false);
    expect(existsSync(join(codex, 'agents', 'bar'))).toBe(false);
    // state 只记 hooks
    const state = JSON.parse(readFileSync(join(store, '.dak-state.json'), 'utf-8'));
    expect(state.targets['codex'].hooks['my-hook']).toBeDefined();
    expect(state.targets['codex'].skills?.['foo']).toBeUndefined();
  });

  it('runLink(codex, resource=未声明) 报 unknown resource type', async () => {
    await expect(
      runLink('codex', { store, homeDir: home, resource: 'unknown', now: FIXED_NOW }),
    ).rejects.toThrow('unknown resource type: unknown');
  });

  it('runLink 支持自定义资源类型声明 + 映射', async () => {
    // 改 config 加自定义类型 A + codex 映射
    const configPath = join(store, 'dak.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.resourceTypes = ['skills', 'hooks', 'agents', 'A'];
    config.targets.codex.resources.A = 'A';
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    mkdirSync(join(codex, 'A'), { recursive: true });
    // store 放 A 资源
    mkdirSync(join(store, 'A'), { recursive: true });
    writeFileSync(join(store, 'A', 'a-item'), 'x');

    const output = await runLink('codex', { store, homeDir: home, now: FIXED_NOW });
    expect(output).toContain('A/a-item');
    expect(readFileSync(join(codex, 'A', 'a-item'), 'utf-8')).toBe('x');
    const state = JSON.parse(readFileSync(join(store, '.dak-state.json'), 'utf-8'));
    expect(state.targets['codex'].A['a-item']).toBeDefined();
  });
});

describe('runUpdate', () => {
  let tmp: string;
  let store: string;
  let home: string;
  let codex: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    store = makeStore(tmp);
    home = makeHome(tmp);
    codex = join(home, '.codex');
    mkdirSync(join(codex, 'skills'), { recursive: true });
    await runInit({ store, homeDir: home });
    // 初始资源
    writeFileSync(join(store, 'skills', 'foo'), 'x');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true });
  });

  it('store 新增 item 后补 symlink', async () => {
    await runLink('codex', { store, homeDir: '/home/test', now: FIXED_NOW });
    // store 新增 bar
    writeFileSync(join(store, 'skills', 'bar'), 'y');
    const output = await runUpdate({ store, homeDir: '/home/test', now: FIXED_NOW });
    expect(output).toContain('created');
    expect(readFileSync(join(codex, 'skills', 'bar'), 'utf-8')).toBe('y');
  });

  it('source 仍存在时 update 不应删除并重建已链接 symlink', async () => {
    await runLink('codex', { store, homeDir: home, now: FIXED_NOW });
    const fooLink = join(codex, 'skills', 'foo');
    // 记录原 symlink 的 inode，update 后应仍是同一 symlink（未被删重建）
    const { lstatSync } = await import('node:fs');
    const before = lstatSync(fooLink).ino;
    const output = await runUpdate({ store, homeDir: home, now: FIXED_NOW });
    const after = lstatSync(fooLink).ino;
    expect(after).toBe(before);
    // 不应出现 foo 的 deleted 行（source 仍存在，非 stale）
    expect(output).not.toContain('codex skills/foo deleted');
    expect(readFileSync(fooLink, 'utf-8')).toBe('x');
  });

  it('store 删除 item 后安全删除旧 symlink', async () => {
    await runLink('codex', { store, homeDir: home, now: FIXED_NOW });
    // 删除 store 中的 foo
    rmSync(join(store, 'skills', 'foo'));
    const output = await runUpdate({ store, homeDir: home, now: FIXED_NOW });
    expect(output).toContain('deleted');
    // target symlink 已删除，读取应抛错
    expect(() => readFileSync(join(codex, 'skills', 'foo'))).toThrow();
  });

  it('只 link 过 codex 时不得刷新 claudecode', async () => {
    const claude = join(home, '.claude');
    mkdirSync(join(claude, 'skills'), { recursive: true });
    // 只 link codex
    await runLink('codex', { store, homeDir: home, now: FIXED_NOW });
    // update 应只更新 codex
    const output = await runUpdate({ store, homeDir: home, now: FIXED_NOW });
    expect(output).not.toContain('claudecode');
  });
});

describe('runStatus', () => {
  let tmp: string;
  let store: string;
  let home: string;
  let codex: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    store = makeStore(tmp);
    home = makeHome(tmp);
    codex = join(home, '.codex');
    mkdirSync(join(codex, 'skills'), { recursive: true });
    await runInit({ store, homeDir: home });
    writeFileSync(join(store, 'skills', 'foo'), 'x');
    writeFileSync(join(store, 'skills', 'stale-item'), 'x');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true });
  });

  it('输出 linked/missing/stale', async () => {
    // link foo
    await runLink('codex', { store, homeDir: home, now: FIXED_NOW });
    // 创建 missing item（store 中存在但未 link）
    mkdirSync(join(store, 'skills', 'missing-item'));
    // stale：store 已删但 state 有记录
    rmSync(join(store, 'skills', 'stale-item'));

    const output = await runStatus({ store, homeDir: home });
    expect(output).toContain('linked');
    expect(output).toContain('missing');
    expect(output).toContain('stale');
  });
});

describe('runUnlink', () => {
  let tmp: string;
  let store: string;
  let home: string;
  let codex: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    store = makeStore(tmp);
    home = makeHome(tmp);
    codex = join(home, '.codex');
    mkdirSync(join(codex, 'skills'), { recursive: true });
    await runInit({ store, homeDir: home });
    writeFileSync(join(store, 'skills', 'foo'), 'x');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true });
  });

  it('只删除 dak 管理的 symlink，不删除 store 资源', async () => {
    await runLink('codex', { store, homeDir: home, now: FIXED_NOW });
    const output = await runUnlink('codex', { store, homeDir: home, now: FIXED_NOW });
    expect(output).toContain('deleted');
    // store 源文件仍在
    expect(readFileSync(join(store, 'skills', 'foo'), 'utf-8')).toBe('x');
    // target 已删除
    expect(() => readFileSync(join(codex, 'skills', 'foo'))).toThrow();
  });
});

describe('runUpdate 边界', () => {
  let tmp: string;
  let store: string;
  let home: string;
  let codex: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    store = makeStore(tmp);
    home = makeHome(tmp);
    codex = join(home, '.codex');
    mkdirSync(join(codex, 'skills'), { recursive: true });
    await runInit({ store, homeDir: home });
    writeFileSync(join(store, 'skills', 'foo'), 'x');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true });
  });

  it('store rename 表现为删除旧 symlink + 创建新 symlink', async () => {
    await runLink('codex', { store, homeDir: home, now: FIXED_NOW });
    // rename foo -> bar（source 改名，旧 record 变 stale，新 item 待链接）
    renameSync(join(store, 'skills', 'foo'), join(store, 'skills', 'bar'));
    const output = await runUpdate({ store, homeDir: home, now: FIXED_NOW });
    // 旧 foo symlink 已清理
    expect(() => readFileSync(join(codex, 'skills', 'foo'))).toThrow();
    // 新 bar 已链接且内容正确
    expect(readFileSync(join(codex, 'skills', 'bar'), 'utf-8')).toBe('x');
    expect(output).toContain('created');
  });

  it('stale target 变真实文件时即使 overwrite 也不删除并保留 state', async () => {
    await runLink('codex', { store, homeDir: home, now: FIXED_NOW });
    // source 删除 → record 变 stale
    rmSync(join(store, 'skills', 'foo'));
    // target 被用户改成真实文件
    rmSync(join(codex, 'skills', 'foo'));
    writeFileSync(join(codex, 'skills', 'foo'), 'user-real');
    const output = await runUpdate({ store, homeDir: home, conflictPolicy: 'overwrite', now: FIXED_NOW });
    // 真实文件未被删除
    expect(readFileSync(join(codex, 'skills', 'foo'), 'utf-8')).toBe('user-real');
    expect(output).toContain('conflict');
    // state record 保留（避免被“忘记管理”）
    const state = JSON.parse(readFileSync(join(store, '.dak-state.json'), 'utf-8'));
    expect(state.targets['codex'].skills['foo']).toBeDefined();
  });
});
