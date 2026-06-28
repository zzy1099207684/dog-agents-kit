/** 资源扫描与格式化 */

import { readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { declaredResourceTypes } from './config.js';
import { assertSafeItemName, isHiddenItem } from './paths.js';
import type { DakConfig, ResourceItem, ResourceType } from './types.js';

/**
 * 资源类型在 list 输出中的显示标题。
 * 默认类型固定标题；自定义类型首字母大写 + 冒号。
 */
function resourceLabel(type: ResourceType): string {
  const defaults: Record<string, string> = {
    skills: 'Skills:',
    hooks: 'Hooks:',
    agents: 'Agents:',
  };
  if (defaults[type]) return defaults[type];
  const cap = type.charAt(0).toUpperCase() + type.slice(1);
  return `${cap}:`;
}

/**
 * 确保 store 目录和声明的各资源类型目录存在。
 */
export async function ensureStoreLayout(storePath: string, config: DakConfig): Promise<void> {
  await mkdir(storePath, { recursive: true });
  for (const type of declaredResourceTypes(config)) {
    await mkdir(join(storePath, type), { recursive: true });
  }
}

/**
 * 扫描 store 中声明的资源类型目录（一级子项）。
 */
export async function scanResources(
  storePath: string,
  config: DakConfig,
): Promise<Record<ResourceType, ResourceItem[]>> {
  const result: Record<ResourceType, ResourceItem[]> = {};

  for (const type of declaredResourceTypes(config)) {
    result[type] = [];
    const dir = join(storePath, type);
    if (!existsSync(dir)) continue;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const items: ResourceItem[] = [];
      for (const entry of entries) {
        const name = entry.name;
        if (isHiddenItem(name)) continue;
        try {
          assertSafeItemName(name);
        } catch {
          continue;
        }
        const fullPath = join(dir, name);
        let kind: ResourceItem['kind'];
        if (entry.isSymbolicLink()) kind = 'symlink';
        else if (entry.isDirectory()) kind = 'directory';
        else kind = 'file';
        items.push({ name, kind, path: fullPath });
      }
      items.sort((a, b) => a.name.localeCompare(b.name));
      result[type] = items;
    } catch {
      // ignore unreadable dir
    }
  }

  return result;
}

/**
 * 格式化资源列表输出（供 `dak list` 使用）。
 * 输出稳定，支持 snapshot 测试。
 */
export function formatResourceList(resources: Record<ResourceType, ResourceItem[]>): string {
  const lines: string[] = [];

  for (const type of Object.keys(resources)) {
    lines.push(resourceLabel(type));
    const items = resources[type];
    if (items.length === 0) {
      lines.push('  (empty)');
    } else {
      for (const item of items) {
        const kind = item.kind === 'directory' ? ' [dir]' : item.kind === 'symlink' ? ' [link]' : '';
        lines.push(`  ${item.name}${kind}`);
      }
    }
  }

  return lines.join('\n');
}
