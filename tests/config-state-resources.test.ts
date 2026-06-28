import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveStorePath,
  createDefaultConfig,
  readConfig,
  writeConfigIfMissing,
  validateConfigStore,
} from '../src/config.js';
import {
  readState,
  writeState,
  writeStateIfMissing,
  upsertLinkRecord,
  removeLinkRecord,
} from '../src/state.js';
import { scanResources, formatResourceList, ensureStoreLayout } from '../src/resources.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TMP_PREFIX = 'dak-config-';

describe('resolveStorePath', () => {
  it('默认 store 解析为 <home>/.dog-agents-kit', () => {
    const result = resolveStorePath(undefined, '/home/test');
    expect(result).toBe('/home/test/.dog-agents-kit');
  });

  it('--store ~/custom-store 展开 home', () => {
    const result = resolveStorePath('~/custom-store', '/home/test');
    expect(result).toBe('/home/test/custom-store');
  });

  it('绝对路径直接返回', () => {
    const result = resolveStorePath('/abs/store', '/home/test');
    expect(result).toBe('/abs/store');
  });
});

describe('createDefaultConfig', () => {
  it('写入绝对 store path', () => {
    const config = createDefaultConfig('/abs/store', '/home/test');
    expect(config.store).toBe('/abs/store');
    expect(config.targets['codex'].path).toBe('/home/test/.codex');
    expect(config.targets['claudecode'].path).toBe('/home/test/.claude');
  });

  it('默认带 resourceTypes = skills/hooks/agents', () => {
    const config = createDefaultConfig('/abs/store', '/home/test');
    expect(config.resourceTypes).toEqual(['skills', 'hooks', 'agents']);
  });
});

describe('自定义资源类型', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true });
  });

  it('ensureStoreLayout 按 declared 建自定义目录', async () => {
    const storePath = join(tmp, 'store');
    const config = { store: storePath, resourceTypes: ['skills', 'A'], targets: {} } as any;
    await ensureStoreLayout(storePath, config);
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(storePath, 'skills'))).toBe(true);
    expect(existsSync(join(storePath, 'A'))).toBe(true);
    expect(existsSync(join(storePath, 'hooks'))).toBe(false);
  });

  it('scanResources 扫描自定义类型目录', async () => {
    const storePath = join(tmp, 'store');
    mkdirSync(join(storePath, 'A'), { recursive: true });
    writeFileSync(join(storePath, 'A', 'item-a'), 'x');
    const config = { store: storePath, resourceTypes: ['skills', 'A'], targets: {} } as any;
    const resources = await scanResources(storePath, config);
    expect(resources.A.map(i => i.name)).toEqual(['item-a']);
    expect(resources.skills).toEqual([]);
    expect(resources.hooks).toBeUndefined();
  });

  it('readConfig 拒绝 target.resources 含未声明类型', async () => {
    const storePath = join(tmp, 'store');
    mkdirSync(storePath);
    writeFileSync(
      join(storePath, 'dak.config.json'),
      JSON.stringify({ store: storePath, resourceTypes: ['skills'], targets: { codex: { path: '/c', resources: { hooks: 'hooks' } } } }),
    );
    await expect(readConfig(storePath)).rejects.toThrow('unknown resource type hooks');
  });

  it('readConfig 拒绝非法 resourceTypes 名（含路径分隔符）', async () => {
    const storePath = join(tmp, 'store');
    mkdirSync(storePath);
    writeFileSync(
      join(storePath, 'dak.config.json'),
      JSON.stringify({ store: storePath, resourceTypes: ['a/b'], targets: {} }),
    );
    await expect(readConfig(storePath)).rejects.toThrow();
  });

  it('readConfig 接受声明的自定义类型 + target 映射', async () => {
    const storePath = join(tmp, 'store');
    mkdirSync(storePath);
    const raw = { store: storePath, resourceTypes: ['skills', 'A'], targets: { codex: { path: '/c', resources: { A: 'A' } } } };
    writeFileSync(join(storePath, 'dak.config.json'), JSON.stringify(raw));
    const config = await readConfig(storePath);
    expect(config.resourceTypes).toEqual(['skills', 'A']);
    expect(config.targets['codex'].resources?.A).toBe('A');
  });

  it('resourceTypes 缺失时回退默认三类', async () => {
    const storePath = join(tmp, 'store');
    mkdirSync(storePath);
    writeFileSync(join(storePath, 'dak.config.json'), JSON.stringify({ store: storePath, targets: {} }));
    const config = await readConfig(storePath);
    const { declaredResourceTypes } = await import('../src/config.js');
    expect(declaredResourceTypes(config)).toEqual(['skills', 'hooks', 'agents']);
  });
});

describe('writeConfigIfMissing', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true });
  });

  it('store 不存在时创建 config', async () => {
    const storePath = join(tmp, 'store');
    const config = createDefaultConfig(storePath, '/home/test');
    await writeConfigIfMissing(storePath, config);
    const content = readFileSync(join(storePath, 'dak.config.json'), 'utf-8');
    expect(JSON.parse(content).store).toBe(storePath);
  });

  it('已存在 dak.config.json 时不覆盖', async () => {
    const storePath = join(tmp, 'store');
    mkdirSync(storePath);
    writeFileSync(join(storePath, 'dak.config.json'), '{"store":"custom"}');
    const config = createDefaultConfig(storePath, '/home/test');
    await writeConfigIfMissing(storePath, config);
    const content = readFileSync(join(storePath, 'dak.config.json'), 'utf-8');
    expect(JSON.parse(content).store).toBe('custom');
  });
});

describe('validateConfigStore', () => {
  it('config.store 和当前 store 不一致时报错', () => {
    const config = { store: '/abs/store', targets: {} } as any;
    expect(() => validateConfigStore(config, '/other/store')).toThrow('config store mismatch');
  });

  it('默认 ~ 路径与解析后 store 不误报 mismatch', () => {
    const config = { store: '~/.dog-agents-kit', targets: {} } as any;
    expect(() => validateConfigStore(config, '/home/u/.dog-agents-kit', '/home/u')).not.toThrow();
  });

  it('~ 展开后与解析 store 匹配', () => {
    const config = { store: '~/x', targets: {} } as any;
    expect(() => validateConfigStore(config, '/home/u/x', '/home/u')).not.toThrow();
  });

  it('相对路径 . 总匹配（按 store 根解析）', () => {
    const config = { store: '.', targets: {} } as any;
    expect(() => validateConfigStore(config, '/abs/store')).not.toThrow();
  });

  it('相对 sub 路径 mismatch', () => {
    const config = { store: 'sub', targets: {} } as any;
    expect(() => validateConfigStore(config, '/abs/store')).toThrow('config store mismatch');
  });
});

describe('scanResources', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true });
  });

  it('只扫一级子项', async () => {
    const storePath = join(tmp, 'store');
    mkdirSync(join(storePath, 'skills', 'nested'), { recursive: true });
    writeFileSync(join(storePath, 'skills', 'top-skill'), 'x');
    writeFileSync(join(storePath, 'skills', 'nested', 'deep'), 'x');
    const config = createDefaultConfig(storePath, '/home/test');
    const resources = await scanResources(storePath, config);
    // 一级子项应包含 top-skill（文件）和 nested（目录），但不含 nested/deep
    const names = resources.skills.map(i => i.name).sort();
    expect(names).toEqual(['nested', 'top-skill']);
    expect(resources.skills.find(i => i.name === 'nested')?.kind).toBe('directory');
  });

  it('hidden item 跳过', async () => {
    const storePath = join(tmp, 'store');
    mkdirSync(join(storePath, 'skills'), { recursive: true });
    writeFileSync(join(storePath, 'skills', '.hidden'), 'x');
    writeFileSync(join(storePath, 'skills', 'visible'), 'x');
    const config = createDefaultConfig(storePath, '/home/test');
    const resources = await scanResources(storePath, config);
    expect(resources.skills.map(i => i.name)).toEqual(['visible']);
  });

  it('文件、目录、symlink 都算 item', async () => {
    const storePath = join(tmp, 'store');
    mkdirSync(join(storePath, 'skills'), { recursive: true });
    writeFileSync(join(storePath, 'skills', 'file-skill'), 'x');
    mkdirSync(join(storePath, 'skills', 'dir-skill'));
    const linkTarget = join(tmp, 'real-target');
    writeFileSync(linkTarget, 'x');
    // symlink via fs.symlinkSync
    const { symlinkSync } = await import('node:fs');
    symlinkSync(linkTarget, join(storePath, 'skills', 'link-skill'));
    const config = createDefaultConfig(storePath, '/home/test');
    const resources = await scanResources(storePath, config);
    const names = resources.skills.map(i => i.name).sort();
    expect(names).toEqual(['dir-skill', 'file-skill', 'link-skill']);
  });

  it('formatResourceList 输出固定标题行', async () => {
    const resources = {
      skills: [{ name: 'foo', kind: 'file' as const, path: '/s/foo' }],
      hooks: [],
      agents: [],
    };
    const output = formatResourceList(resources);
    expect(output).toContain('Skills:');
    expect(output).toContain('Hooks:');
    expect(output).toContain('Agents:');
    expect(output).toContain('foo');
  });
});

describe('readState / writeState', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true });
  });

  it('缺文件时返回空状态', async () => {
    const state = await readState(join(tmp, 'no-store'));
    expect(state.version).toBe(1);
    expect(state.targets).toEqual({});
  });

  it('只接受 version: 1', async () => {
    const storePath = join(tmp, 'store');
    mkdirSync(storePath);
    writeFileSync(join(storePath, '.dak-state.json'), '{"version":2,"targets":{}}');
    await expect(readState(storePath)).rejects.toThrow('unsupported state version');
  });

  it('写状态后可读回', async () => {
    const storePath = join(tmp, 'store');
    mkdirSync(storePath);
    const state = { version: 1, targets: {} };
    await writeState(storePath, state);
    const read = await readState(storePath);
    expect(read).toEqual(state);
  });
});
