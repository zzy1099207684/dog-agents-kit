import { describe, it, expect } from 'vitest';
import {
  expandHome,
  toAbsolutePath,
  isHiddenItem,
  assertSafeItemName,
  isPathInside,
  realComparablePath,
  resolveLinkTarget,
  realParentJoined,
} from '../src/paths.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('expandHome', () => {
  it('展开 ~ 为指定 home', () => {
    expect(expandHome('~/foo', '/home/test')).toBe('/home/test/foo');
  });

  it('~ 本身展开为 home', () => {
    expect(expandHome('~', '/home/test')).toBe('/home/test');
  });

  it('非 ~ 路径原样返回', () => {
    expect(expandHome('/abs/path', '/home/test')).toBe('/abs/path');
  });
});

describe('toAbsolutePath', () => {
  it('相对路径按 baseDir 解析', () => {
    expect(toAbsolutePath('foo/bar', '/base', '/home')).toBe('/base/foo/bar');
  });

  it('~ 路径展开后解析', () => {
    expect(toAbsolutePath('~/.config', '/base', '/home')).toBe('/home/.config');
  });

  it('绝对路径 resolve', () => {
    expect(toAbsolutePath('/foo/../bar', '/base', '/home')).toBe('/bar');
  });
});

describe('isHiddenItem', () => {
  it('.hidden 返回 true', () => {
    expect(isHiddenItem('.hidden')).toBe(true);
  });

  it('.foo 返回 true', () => {
    expect(isHiddenItem('.foo')).toBe(true);
  });

  it('foo 返回 false', () => {
    expect(isHiddenItem('foo')).toBe(false);
  });
});

describe('assertSafeItemName', () => {
  it('隐藏项抛出', () => {
    expect(() => assertSafeItemName('.hidden')).toThrow('Hidden resource items are ignored');
  });

  it('斜杠抛出', () => {
    expect(() => assertSafeItemName('group/foo')).toThrow('Invalid resource item name');
  });

  it('反斜杠抛出', () => {
    expect(() => assertSafeItemName('group\\foo')).toThrow('Invalid resource item name');
  });

  it('. 单独抛出', () => {
    expect(() => assertSafeItemName('.')).toThrow('Invalid resource item name');
  });

  it('.. 抛出', () => {
    expect(() => assertSafeItemName('..')).toThrow('Invalid resource item name');
  });

  it('合法名称不抛', () => {
    expect(() => assertSafeItemName('foo')).not.toThrow();
  });
});

describe('isPathInside', () => {
  it('/tmp/store 内路径返回 true', () => {
    expect(isPathInside('/tmp/store/a', '/tmp/store')).toBe(true);
  });

  it('/tmp/store-other 不被 /tmp/store 骗过', () => {
    expect(isPathInside('/tmp/store-other/a', '/tmp/store')).toBe(false);
  });

  it('/tmp/store 自身返回 true', () => {
    expect(isPathInside('/tmp/store', '/tmp/store')).toBe(true);
  });

  it('/tmp/store 深层返回 true', () => {
    expect(isPathInside('/tmp/store/a/b/c', '/tmp/store')).toBe(true);
  });

  it('/tmp/other 返回 false', () => {
    expect(isPathInside('/tmp/other', '/tmp/store')).toBe(false);
  });
});

describe('realComparablePath', () => {
  it('真实路径文件返回 resolved path', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dak-paths-'));
    const f = join(tmp, 'file.txt');
    writeFileSync(f, 'x');
    const result = await realComparablePath(f);
    expect(result).toBe(f);
    rmSync(tmp, { recursive: true });
  });
});

describe('resolveLinkTarget', () => {
  it('绝对 target 直接 resolve', async () => {
    const result = await resolveLinkTarget('/tmp/link', '/abs/target');
    expect(result).toBe('/abs/target');
  });

  it('相对 target 按 link parent 解析', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dak-paths-'));
    const linkPath = join(tmp, 'sub', 'link');
    const sourcePath = join(tmp, 'src');
    mkdirSync(join(tmp, 'sub'), { recursive: true });
    mkdirSync(sourcePath, { recursive: true });
    writeFileSync(join(sourcePath, 'item'), 'x');
    const result = await resolveLinkTarget(linkPath, '../src/item');
    expect(result).toBe(join(sourcePath, 'item'));
    rmSync(tmp, { recursive: true });
  });
});

describe('realParentJoined', () => {
  it('父目录存在时用真实路径拼接', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dak-paths-'));
    const dir = join(tmp, 'real-dir');
    mkdirSync(dir);
    const result = await realParentJoined(join(dir, 'child'));
    expect(result).toBe(join(dir, 'child'));
    rmSync(tmp, { recursive: true });
  });

  it('父目录不存在时向上找祖先', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dak-paths-'));
    const existing = join(tmp, 'existing');
    mkdirSync(existing);
    const result = await realParentJoined(join(existing, 'missing', 'child'));
    expect(result).toBe(join(existing, 'missing', 'child'));
    rmSync(tmp, { recursive: true });
  });
});
