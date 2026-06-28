/** 命令工作流 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig, createDefaultConfig, validateConfigStore, writeConfigIfMissing, resolveStorePath } from './config.js';
import { readState, writeState, writeStateIfMissing, upsertLinkRecord, removeLinkRecord, removeTargetState } from './state.js';
import { scanResources, formatResourceList, ensureStoreLayout } from './resources.js';
import { classifyTarget, linkItem, safeDeleteManagedLink } from './linker.js';
import { declaredResourceTypes } from './config.js';
import type { ResourceType, ConflictPolicy } from './types.js';

/** 命令选项 */
export interface CommandOptions {
  store?: string;
  homeDir?: string;
  conflictPolicy?: ConflictPolicy;
  interactive?: boolean;
  chooseConflict?: (target: string, resource: string, item: string) => Promise<ConflictPolicy> | ConflictPolicy;
  now?: Date;
  /** 限定单资源类型；未指定时遍历全部声明的资源类型 */
  resource?: ResourceType;
}

/**
 * 冲突解析器（供交互模式使用）。
 */
export type ConflictResolver = (target: string, resource: string, item: string) => Promise<ConflictPolicy> | ConflictPolicy;

/**
 * 加载上下文（store/config/state）。
 */
async function loadContext(opts: CommandOptions) {
  const homeDir = opts.homeDir ?? process.env.HOME ?? '';
  const storePath = resolveStorePath(opts.store, homeDir);
  const config = await readConfig(storePath);
  validateConfigStore(config, storePath, homeDir);
  const state = await readState(storePath);
  return { storePath, config, state, homeDir };
}

/**
 * 解析目标名称（支持 all）。
 */
function resolveTargetNames(target: string, config: Record<string, any>): string[] {
  if (target === 'all') {
    return Object.keys(config.targets ?? {});
  }
  if (!config.targets?.[target]) {
    throw new Error(`unknown target: ${target}`);
  }
  return [target];
}

/**
 * 本次命令要处理的资源类型集合。
 * 指定 --resource 时只跑该类型，否则跑 config 声明的全部资源类型。
 */
function effectiveResourceTypes(opts: CommandOptions, config: Record<string, any>): readonly ResourceType[] {
  if (opts.resource) {
    const declared = declaredResourceTypes(config as any);
    if (!declared.includes(opts.resource)) {
      throw new Error(`unknown resource type: ${opts.resource}`);
    }
    return [opts.resource];
  }
  return declaredResourceTypes(config as any);
}

/**
 * 获取目标 resource 路径（未配置则返回 null）。
 */
function targetResourcePath(config: Record<string, any>, targetName: string, resourceType: ResourceType): string | null {
  const t = config.targets?.[targetName];
  if (!t?.resources?.[resourceType]) return null;
  return join(t.path, t.resources[resourceType]);
}

/**
 * 构造冲突解析器（仅真实 conflict/broken 时由 linkItem 回调）。
 * 有静态 --on-conflict 时不问；否则 interactive 模式下委托 chooseConflict。
 * 返回 undefined 表示无 resolver，linkItem 回退到 policy（默认 skip）。
 */
function resolveConflictFor(
  opts: CommandOptions,
  target: string,
  resource: string,
  item: string,
): (() => Promise<ConflictPolicy> | ConflictPolicy) | undefined {
  if (opts.conflictPolicy) return undefined;
  if (opts.interactive && opts.chooseConflict) {
    return () => opts.chooseConflict!(target, resource, item);
  }
  return undefined;
}

/** ─── Commands ─── **/

/** 初始化 store */
export async function runInit(opts: CommandOptions): Promise<string> {
  const homeDir = opts.homeDir ?? process.env.HOME ?? '';
  const storePath = resolveStorePath(opts.store, homeDir);
  const config = createDefaultConfig(storePath, homeDir);
  await ensureStoreLayout(storePath, config);
  await writeConfigIfMissing(storePath, config);
  await writeStateIfMissing(storePath);
  return `Initialized dak store at ${storePath}`;
}

/** 列出资源 */
export async function runList(opts: CommandOptions): Promise<string> {
  const { storePath, config } = await loadContext(opts);
  const resources = await scanResources(storePath, config);
  return formatResourceList(resources);
}

/** 链接资源到目标 */
export async function runLink(targetArg: string, opts: CommandOptions): Promise<string> {
  const { storePath, config, state } = await loadContext(opts);
  const targetNames = resolveTargetNames(targetArg, config);
  const lines: string[] = [];
  let linked = 0, created = 0, conflicts = 0;
  const items = await scanResources(storePath, config);

  for (const tName of targetNames) {
    for (const resourceType of effectiveResourceTypes(opts, config)) {
      const targetPath = targetResourcePath(config, tName, resourceType);
      if (!targetPath) continue; // target 未配置此 resource，跳过
      for (const item of items[resourceType]) {
        const itemTargetPath = join(targetPath, item.name);
        const outcome = await linkItem({
          sourcePath: item.path,
          targetPath: itemTargetPath,
          resourceType,
          itemName: item.name,
          storePath,
          policy: opts.conflictPolicy,
          resolveConflict: resolveConflictFor(opts, tName, resourceType, item.name),
          now: opts.now,
        });

        // 写 state
        if (outcome.record) {
          upsertLinkRecord(state, tName, resourceType, item.name, outcome.record);
        }

        let status = '';
        switch (outcome.status) {
          case 'linked': status = 'linked'; linked++; break;
          case 'created': status = 'created'; created++; break;
          case 'backed-up': status = 'backed-up'; created++; break;
          case 'overwritten': status = 'overwritten'; created++; break;
          case 'conflict': status = 'conflict'; conflicts++; break;
        }

        lines.push(`${tName} ${resourceType}/${item.name} ${status} ${itemTargetPath}`);
      }
    }
  }

  await writeState(storePath, state);
  lines.push(`Summary: linked=${linked} created=${created} conflicts=${conflicts}`);
  return lines.join('\n');
}

/** 状态检查 */
export async function runStatus(opts: CommandOptions): Promise<string> {
  const { storePath, config, state } = await loadContext(opts);
  const storeItems = await scanResources(storePath, config);
  const lines: string[] = [];

  for (const [tName, tState] of Object.entries(state.targets)) {
    for (const resourceType of effectiveResourceTypes(opts, config)) {
      const targetPath = targetResourcePath(config, tName, resourceType);
      if (!targetPath) continue;
      const records = tState[resourceType] ?? {};
      const storeItemsForType = storeItems[resourceType] ?? [];
      const storeItemMap = new Map(storeItemsForType.map(i => [i.name, i]));

      // 当前 store 中的 items
      for (const item of storeItemsForType) {
        const itemTargetPath = join(targetPath, item.name);
        const category = await classifyTarget(itemTargetPath, item.path);
        lines.push(`${tName} ${resourceType}/${item.name} ${category} ${itemTargetPath}`);
      }

      // state 中已存在但 store 已删除（stale）
      for (const [itemName, record] of Object.entries(records)) {
        if (storeItemMap.has(itemName)) continue;
        const itemTargetPath = record.target;
        lines.push(`${tName} ${resourceType}/${itemName} stale ${itemTargetPath}`);
      }
    }
  }

  return lines.join('\n');
}

/** 更新（补链接 + 清理 stale） */
export async function runUpdate(opts: CommandOptions): Promise<string> {
  const { storePath, config, state } = await loadContext(opts);
  const lines: string[] = [];
  let created = 0, deleted = 0, missingCount = 0, skipped = 0, conflicts = 0;

  // target 集合只能来自 state.targets（已 link 过的 targets）
  const targetNames = Object.keys(state.targets);
  const storeItems = await scanResources(storePath, config);

  for (const tName of targetNames) {
    const tState = state.targets[tName];
    for (const resourceType of effectiveResourceTypes(opts, config)) {
      const targetPath = targetResourcePath(config, tName, resourceType);
      if (!targetPath) continue;
      const records = { ...(tState[resourceType] ?? {}) };

      // 1. 清理 stale
      for (const [itemName, record] of Object.entries(records)) {
        const sourcePath = record.source;
        if (!existsSync(sourcePath)) {
          // stale：state 中有记录但 store 已无源
          const result = await safeDeleteManagedLink(record, storePath);
          switch (result) {
            case 'deleted':
              removeLinkRecord(state, tName, resourceType, itemName);
              deleted++;
              lines.push(`${tName} ${resourceType}/${itemName} deleted ${record.target}`);
              break;
            case 'missing':
              removeLinkRecord(state, tName, resourceType, itemName);
              missingCount++;
              lines.push(`${tName} ${resourceType}/${itemName} missing ${record.target}`);
              break;
            case 'conflict':
              conflicts++;
              lines.push(`${tName} ${resourceType}/${itemName} conflict ${record.target}`);
              break;
          }
        }
      }

      // 2. 为当前 store item 补链接
      for (const item of storeItems[resourceType]) {
        const itemTargetPath = join(targetPath, item.name);
        const outcome = await linkItem({
          sourcePath: item.path,
          targetPath: itemTargetPath,
          resourceType,
          itemName: item.name,
          storePath,
          policy: opts.conflictPolicy,
          resolveConflict: resolveConflictFor(opts, tName, resourceType, item.name),
          now: opts.now,
        });

        if (outcome.record) {
          upsertLinkRecord(state, tName, resourceType, item.name, outcome.record);
        }

        switch (outcome.status) {
          case 'linked':
            skipped++;
            lines.push(`${tName} ${resourceType}/${item.name} linked ${itemTargetPath}`);
            break;
          case 'created':
            created++;
            lines.push(`${tName} ${resourceType}/${item.name} created ${itemTargetPath}`);
            break;
          case 'backed-up':
            created++;
            lines.push(`${tName} ${resourceType}/${item.name} backed-up ${itemTargetPath}`);
            break;
          case 'overwritten':
            created++;
            lines.push(`${tName} ${resourceType}/${item.name} overwritten ${itemTargetPath}`);
            break;
          case 'conflict':
            conflicts++;
            lines.push(`${tName} ${resourceType}/${item.name} conflict ${itemTargetPath}`);
            break;
        }
      }
    }
  }

  await writeState(storePath, state);
  lines.push(`Summary: created=${created} deleted=${deleted} missing=${missingCount} skipped=${skipped} conflicts=${conflicts}`);
  return lines.join('\n');
}

/** 取消链接 */
export async function runUnlink(targetArg: string, opts: CommandOptions): Promise<string> {
  const { storePath, config, state } = await loadContext(opts);
  const targetNames = resolveTargetNames(targetArg, config);
  const lines: string[] = [];
  let deleted = 0, missingCount = 0, conflicts = 0;

  for (const tName of targetNames) {
    const tState = state.targets[tName];
    if (!tState) continue;
    for (const resourceType of effectiveResourceTypes(opts, config)) {
      const records = { ...(tState[resourceType] ?? {}) };
      for (const [itemName, record] of Object.entries(records)) {
        const result = await safeDeleteManagedLink(record, storePath);
        switch (result) {
          case 'deleted':
            removeLinkRecord(state, tName, resourceType, itemName);
            deleted++;
            lines.push(`${tName} ${resourceType}/${itemName} deleted ${record.target}`);
            break;
          case 'missing':
            removeLinkRecord(state, tName, resourceType, itemName);
            missingCount++;
            lines.push(`${tName} ${resourceType}/${itemName} missing ${record.target}`);
            break;
          case 'conflict':
            conflicts++;
            lines.push(`${tName} ${resourceType}/${itemName} conflict ${record.target}`);
            break;
        }
      }
    }
    // 如果 target 下所有 records 都已删完，移除 target state
    if (tState && Object.values(tState).every(m => Object.keys(m).length === 0)) {
      removeTargetState(state, tName);
    }
  }

  await writeState(storePath, state);
  lines.push(`Summary: deleted=${deleted} missing=${missingCount} conflicts=${conflicts}`);
  return lines.join('\n');
}
