/** 配置读写与校验 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG, DEFAULT_STORE, CONFIG_FILE, INSTRUCTIONS_TYPE } from './constants.js';
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
  const targets: DakConfig['targets'] = {};
  for (const [name, t] of Object.entries(DEFAULT_CONFIG.targets)) {
    targets[name] = {
      path: toAbsolutePath(t.path, home, home),
      resources: t.resources,
      instructions: t.instructions,
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
  applyInstructionDefaults(config);
  return config;
}

/**
 * 为缺少 instructions 的已知目标回填默认文件名。
 * dak init 不覆盖已有配置，老用户升级后配置里不会自然长出该字段，
 * 回填使升级即生效，无需手改配置。只改内存对象，不回写磁盘。
 * 想让某个工具不参与，用 `dak link <target>` 按目标执行，不靠删配置字段表达。
 */
function applyInstructionDefaults(config: DakConfig): void {
  for (const [name, t] of Object.entries(config.targets)) {
    if (t.instructions !== undefined) continue;
    // 自定义目标（如 cursor）没有默认文件名可回填，保持不参与
    const fallback = DEFAULT_CONFIG.targets[name]?.instructions;
    if (fallback) t.instructions = fallback;
  }
}

/**
 * 校验 config 结构：targets 必须存在；resourceTypes 中每个类型名必须合法；
 * target.resources 的 key 必须在声明的 resourceTypes 内；
 * target.instructions 必须是合法文件名。
 * @throws 结构非法时抛错
 */
function validateConfigShape(config: DakConfig): void {
  if (!config || typeof config !== 'object' || !config.targets) {
    throw new Error('Invalid config: targets missing');
  }
  const validResources = new Set<string>(declaredResourceTypes(config));
  // instructions 走独立映射规则，若混入 resourceTypes 会被通用循环按"子目录 + 同名条目"处理，生成错误路径
  if (validResources.has(INSTRUCTIONS_TYPE)) {
    throw new Error(`Invalid config: ${INSTRUCTIONS_TYPE} is reserved and cannot be declared in resourceTypes`);
  }
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
    if (t.instructions !== undefined) {
      if (typeof t.instructions !== 'string') {
        throw new Error(`Invalid config: target ${name} instructions must be a string`);
      }
      try {
        assertSafeItemName(t.instructions);
      } catch {
        throw new Error(`Invalid config: target ${name} has invalid instructions file name`);
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
