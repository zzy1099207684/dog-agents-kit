import { describe, it, expect } from 'vitest';
import { parseArgv, main } from '../src/cli.js';
import type { ParsedArgs } from '../src/cli.js';

describe('parseArgv', () => {
  it('link codex --store /tmp/store --on-conflict backup', () => {
    const result = parseArgv(['link', 'codex', '--store', '/tmp/store', '--on-conflict', 'backup']);
    expect(result.command).toBe('link');
    expect(result.target).toBe('codex');
    expect(result.store).toBe('/tmp/store');
    expect(result.onConflict).toBe('backup');
  });

  it('非法 conflict policy 报错', () => {
    expect(() => parseArgv(['link', 'codex', '--on-conflict', 'invalid']))
      .toThrow('Invalid conflict policy');
  });

  it('status 无 target', () => {
    const result = parseArgv(['status', '--store', '/tmp/store']);
    expect(result.command).toBe('status');
    expect(result.target).toBeUndefined();
  });

  it('link 缺 target 报错', () => {
    expect(() => parseArgv(['link']))
      .toThrow('target is required');
  });

  it('unlink 缺 target 报错', () => {
    expect(() => parseArgv(['unlink']))
      .toThrow('target is required');
  });

  it('link codex -r hooks 解析 resource', () => {
    const result = parseArgv(['link', 'codex', '-r', 'hooks']);
    expect(result.command).toBe('link');
    expect(result.target).toBe('codex');
    expect(result.resource).toBe('hooks');
  });

  it('link codex --resource skills 解析 resource', () => {
    const result = parseArgv(['link', 'codex', '--resource', 'skills']);
    expect(result.resource).toBe('skills');
  });

  it('非法 resource（含路径分隔符）报错', () => {
    expect(() => parseArgv(['link', 'codex', '-r', 'a/b']))
      .toThrow('Invalid resource type');
  });

  it('自定义 resource 名称通过 cli 解析（declared 校验在 commands 层）', () => {
    const result = parseArgv(['link', 'codex', '-r', 'custom']);
    expect(result.resource).toBe('custom');
  });

  it('-r 缺值报错', () => {
    expect(() => parseArgv(['link', 'codex', '-r']))
      .toThrow('--resource requires a value');
  });
});

describe('main', () => {
  it('未知命令报错', async () => {
    const code = await main(['unknown']);
    expect(code).toBe(1);
  });

  it('link 缺 target 返回 1', async () => {
    const code = await main(['link']);
    expect(code).toBe(1);
  });
});
