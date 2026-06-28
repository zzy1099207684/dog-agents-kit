/** 路径工具函数 */

import { existsSync, promises as fsPromises } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * 将路径中的 ~ 展开为用户主目录。
 * @param input 输入路径
 * @param homeDir 用户主目录绝对路径
 * @returns 展开后的绝对路径
 */
export function expandHome(input: string, homeDir: string): string {
  if (input === '~') return homeDir;
  if (input.startsWith('~/')) return homeDir + input.slice(1);
  return input;
}

/**
 * 将输入路径解析为绝对路径。
 * 支持 ~ 展开、相对路径拼接、自动 normalize。
 * @param input 输入路径（支持 ~ 前缀或相对路径）
 * @param baseDir 相对路径的基准目录
 * @param homeDir 用于 ~ 展开的主目录
 * @returns 解析后的绝对路径
 */
export function toAbsolutePath(input: string, baseDir: string, homeDir: string): string {
  const expanded = expandHome(input, homeDir);
  if (expanded.startsWith('/')) {
    return resolve(expanded);
  }
  return resolve(baseDir, expanded);
}

/**
 * 判断名称是否为隐藏项（以 . 开头）。
 * @param name 文件/目录名称
 * @returns 是否隐藏
 */
export function isHiddenItem(name: string): boolean {
  const base = dirname(name) === '.' ? name : name.split('/').pop() ?? name;
  return base.startsWith('.');
}

/**
 * 校验资源项名称是否合法。
 * @param name 资源项名称
 * @throws 名称非法时抛出错误
 */
export function assertSafeItemName(name: string): void {
  const base = dirname(name) === '.' ? name : name.split('/').pop() ?? name;
  // 先检查 . 和 ..（它们是合法 hidden item，但应报 "Invalid"）
  if (name === '.' || name === '..') {
    throw new Error('Invalid resource item name');
  }
  if (isHiddenItem(base)) {
    throw new Error('Hidden resource items are ignored');
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new Error('Invalid resource item name');
  }
}

/**
 * 判断 child 路径是否在 parent 路径内部（严格前缀匹配，防止边界欺骗）。
 * @param child 子路径
 * @param parent 父路径
 * @returns 是否在内部
 */
export function isPathInside(child: string, parent: string): boolean {
  const normalizedChild = resolve(child);
  let normalizedParent = resolve(parent);
  if (!normalizedParent.endsWith('/')) {
    normalizedParent += '/';
  }
  // 子路径在父目录内（严格前缀）
  if (normalizedChild.startsWith(normalizedParent)) return true;
  // 子路径等于父目录本身
  if (normalizedChild === parent || normalizedChild + '/' === normalizedParent) return true;
  return false;
}

/**
 * 获取路径的可比较真实路径。
 * 尝试 fs.realpath，失败时 fallback 到 path.resolve。
 * @param input 输入路径
 * @returns 绝对路径
 */
export async function realComparablePath(input: string): Promise<string> {
  try {
    return await realpath(input);
  } catch {
    return resolve(input);
  }
}

/**
 * 解析 symlink 的实际目标路径。
 * @param linkPath 链接文件的实际路径
 * @param rawTarget 链接原始 target（相对或绝对）
 * @returns 解析后的绝对目标路径
 */
export async function resolveLinkTarget(linkPath: string, rawTarget: string): Promise<string> {
  if (rawTarget.startsWith('/')) {
    return resolve(rawTarget);
  }
  const realParent = await realParentJoined(dirname(linkPath));
  const resolved = join(realParent, rawTarget);
  return resolve(resolved);
}

/**
 * 获取路径的"真实父目录 + 剩余相对部分"拼接结果。
 * 向上逐级查找最近存在的目录取 realpath，再拼接剩余部分。
 * @param path 目标路径
 * @returns 拼接后的绝对路径
 */
export async function realParentJoined(path: string): Promise<string> {
  const dir = dirname(path);
  const basename = path.split('/').pop() ?? '';

  // 向上逐级查找最近存在的目录
  let current = dir;
  const segments: string[] = [];
  let foundExisting: string | null = null;
  let remainingSegments: string[] = [];

  while (current !== segments.join('/')) {
    if (existsSync(current)) {
      foundExisting = current;
      // 计算还需要拼接的部分
      const dirSegments = dir.split('/').filter(Boolean);
      const foundSegments = foundExisting.split('/').filter(Boolean);
      remainingSegments = dirSegments.slice(foundSegments.length);
      remainingSegments.push(basename);
      break;
    }
    segments.unshift(current.split('/').pop() ?? '');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  if (foundExisting) {
    const realAncestor = await realpath(foundExisting);
    const remaining = remainingSegments.join('/');
    return join(realAncestor, remaining);
  }

  return resolve(path);
}
