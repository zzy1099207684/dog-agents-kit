/** 配置读写与校验 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG, DEFAULT_STORE, CONFIG_FILE } from './constants.js';
import type { DakConfig } from './types.js';
import { DEFAULT_RESOURCE_TYPES } from './types.js';
import { assertSafeItemName, expandHome, toAbsolutePath } from './paths.js';

/**
 * 解析 config 声明的资源类型集合。
 * 缺失或空时回退 DEFAULT_RESOURCE_TYPES。
 */
export function declaredResourceTypes(config: DakConfig): string[] {
  const types = config.resourceTypes ?? [...DEFAULT_RESOURCE_TYPES];
  return types.length > 0 ? [...types] : [...DEFAULT_RESOURCE_TYPES];
}

/**
 * 解析 store 路径。
 * @param storeArg CLI --store 参数
 * @param homeDir 用户主目录
 */
export function resolveStorePath(storeArg?: string, homeDir?: string): string {
  const home = homeDir ?? process.env.HOME ?? '';
  if (storeArg) {
    return toAbsolutePath(storeArg, home, home);
  }
  return toAbsolutePath(DEFAULT_STORE, home, home);
}

/**
 * 创建默认配置（内存对象，不写入磁盘）。
 * @param storePath 绝对 store 路径
 * @param homeDir 用户主目录
 */
export function createDefaultConfig(storePath: string, homeDir?: string): DakConfig {
  const home = homeDir ?? process.env.HOME ?? '';
  const targets: Record<string, { path: string; resources?: Partial<Record<string, string>> }> = {};
  for (const [name, t] of Object.entries(DEFAULT_CONFIG.targets)) {
    targets[name] = {
      path: toAbsolutePath(t.path, home, home),
      resources: t.resources,
    };
  }
  return { store: storePath, resourceTypes: [...DEFAULT_RESOURCE_TYPES], targets };
}

/**
 * 从磁盘读取配置并校验结构。
 * 校验：targets 存在；resourceTypes 合法；target.resources key 必须在声明的 resourceTypes 内。
 * store 顶层资源目录的布局由 ensureStoreLayout 保证，不在 readConfig 校验。
 * @param storePath store 绝对路径
 */
export async function readConfig(storePath: string): Promise<DakConfig> {
  const configPath = join(storePath, CONFIG_FILE);
  const raw = await readFile(configPath, 'utf-8');
  const config = JSON.parse(raw) as DakConfig;
  validateConfigShape(config);
  return config;
}

/**
 * 校验 config 结构：targets 必须存在；resourceTypes 中每个类型名必须合法；
 * target.resources 的 key 必须在声明的 resourceTypes 内。
 * @throws 结构非法时抛错
 */
function validateConfigShape(config: DakConfig): void {
  if (!config || typeof config !== 'object' || !config.targets) {
    throw new Error('Invalid config: targets missing');
  }
  const validResources = new Set<string>(declaredResourceTypes(config));
  for (const type of validResources) {
    assertSafeItemName(type);
  }
  for (const [name, t] of Object.entries(config.targets)) {
    if (!t || typeof t.path !== 'string') {
      throw new Error(`Invalid config: target ${name} missing path`);
    }
    if (t.resources) {
      for (const key of Object.keys(t.resources)) {
        if (!validResources.has(key)) {
          throw new Error(`Invalid config: target ${name} has unknown resource type ${key}`);
        }
      }
    }
  }
}

/**
 * 仅当配置文件不存在时写入。
 */
export async function writeConfigIfMissing(storePath: string, config: DakConfig): Promise<void> {
  const configPath = join(storePath, CONFIG_FILE);
  if (existsSync(configPath)) return;
  await mkdir(storePath, { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * 校验 config.store 与当前加载 store 是否一致。
 * 相对路径按 store 根目录解析；`~` 按当前命令 home 解析（计划全局约束）。
 * @throws 不一致时抛错
 */
export function validateConfigStore(config: DakConfig, storePath: string, homeDir?: string): void {
  const home = homeDir ?? process.env.HOME ?? '';
  const configStore = toAbsolutePath(config.store, storePath, home);
  const currentStore = toAbsolutePath(storePath, home, home);
  if (configStore !== currentStore) {
    throw new Error('config store mismatch');
  }
}
