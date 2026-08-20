/** 命令工作流 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig, createDefaultConfig, validateConfigStore, writeConfigIfMissing, resolveStorePath } from './config.js';
import { readState, writeState, writeStateIfMissing, upsertLinkRecord, removeLinkRecord, removeTargetState } from './state.js';
import { scanResources, scanInstructions, formatResourceList, ensureStoreLayout } from './resources.js';
import { classifyTarget, linkItem, safeDeleteManagedLink } from './linker.js';
import type { LinkOutcome } from './linker.js';
import { declaredResourceTypes } from './config.js';
import { INSTRUCTIONS_TYPE } from './constants.js';
import type { ResourceType, ConflictPolicy, ResourceItem, DakState } from './types.js';

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
    // instructions 不在 declaredResourceTypes 内，由 includeInstructions 单独处理
    if (opts.resource === INSTRUCTIONS_TYPE) return [];
    const declared = declaredResourceTypes(config as any);
    if (!declared.includes(opts.resource)) {
      throw new Error(`unknown resource type: ${opts.resource}`);
    }
    return [opts.resource];
  }
  return declaredResourceTypes(config as any);
}

/**
 * 本次命令是否处理指令文件。
 * 未指定 --resource 时处理；指定时仅当值为 instructions。
 */
function includeInstructions(opts: CommandOptions): boolean {
  return !opts.resource || opts.resource === INSTRUCTIONS_TYPE;
}

/**
 * 遍历 state 记录时要覆盖的资源类型集合。
 * 指令记录挂在 INSTRUCTIONS_TYPE 下，而该类型不在 declaredResourceTypes 中，需额外补上。
 */
function stateResourceTypes(opts: CommandOptions, config: Record<string, any>): ResourceType[] {
  const types = [...effectiveResourceTypes(opts, config)];
  if (includeInstructions(opts)) types.push(INSTRUCTIONS_TYPE);
  return types;
}

/**
 * 从 store/instructions 的扫描结果中取唯一一份。
 * 一个 target 根目录只能有一个指令文件，放多份无法判断该链哪份，故直接中止。
 */
function requireSingleInstruction(items: ResourceItem[]): ResourceItem | null {
  if (items.length === 0) return null;
  if (items.length > 1) {
    const names = items.map(i => i.name).join(', ');
    throw new Error(
      `${INSTRUCTIONS_TYPE}/ must contain exactly one file, found ${items.length}: ${names}. Remove the extras and keep one.`,
    );
  }
  return items[0];
}

/** 本次命令要处理的指令文件；未启用或 store 为空时为 null。 */
async function resolveInstruction(
  opts: CommandOptions,
  storePath: string,
): Promise<ResourceItem | null> {
  if (!includeInstructions(opts)) return null;
  return requireSingleInstruction(await scanInstructions(storePath));
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
 * target 是否配置了该资源类型的落点。
 * 遍历 state 记录时用它保持与 buildLinkPlans 一致的跳过规则，避免未配置的类型被误报 stale。
 */
function targetHandlesResource(
  config: Record<string, any>,
  targetName: string,
  resourceType: ResourceType,
): boolean {
  if (resourceType === INSTRUCTIONS_TYPE) {
    return Boolean(config.targets?.[targetName]?.instructions);
  }
  return targetResourcePath(config, targetName, resourceType) !== null;
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

/** 一条待处理的链接项：store 源 → target 中的落点 */
interface LinkPlan {
  resourceType: ResourceType;
  /** state 记录键，取 store 中的条目名 */
  itemName: string;
  sourcePath: string;
  targetPath: string;
  /** 备份根目录；仅指令文件需要显式指定（见 linkItem.backupRootDir） */
  backupRootDir?: string;
  /** 固定冲突策略，覆盖 --on-conflict 与交互询问 */
  forcedPolicy?: ConflictPolicy;
}

/**
 * 展开某个 target 下本次要处理的全部链接项。
 * 常规资源是"子目录 + 同名条目"，指令文件是"target 根目录 + 改名"，
 * 在此统一成一份列表，使 link/status/update 共用同一套遍历。
 */
function buildLinkPlans(
  opts: CommandOptions,
  config: Record<string, any>,
  targetName: string,
  items: Record<ResourceType, ResourceItem[]>,
  instruction: ResourceItem | null,
): LinkPlan[] {
  const plans: LinkPlan[] = [];

  for (const resourceType of effectiveResourceTypes(opts, config)) {
    const dir = targetResourcePath(config, targetName, resourceType);
    if (!dir) continue; // target 未配置此 resource，跳过
    for (const item of items[resourceType] ?? []) {
      plans.push({
        resourceType,
        itemName: item.name,
        sourcePath: item.path,
        targetPath: join(dir, item.name),
      });
    }
  }

  const t = config.targets?.[targetName];
  if (instruction && t?.instructions) {
    plans.push({
      resourceType: INSTRUCTIONS_TYPE,
      itemName: instruction.name,
      sourcePath: instruction.path,
      targetPath: join(t.path, t.instructions),
      backupRootDir: t.path,
      // 指令文件占用 target 根目录的固定文件名，冲突时一律先备份再接管，不询问也不静默跳过
      forcedPolicy: 'backup',
    });
  }

  return plans;
}

/** 按 plan 建立链接并写回 state。 */
async function applyLinkPlan(
  plan: LinkPlan,
  targetName: string,
  storePath: string,
  state: DakState,
  opts: CommandOptions,
): Promise<LinkOutcome> {
  const outcome = await linkItem({
    sourcePath: plan.sourcePath,
    targetPath: plan.targetPath,
    resourceType: plan.resourceType,
    itemName: plan.itemName,
    storePath,
    policy: plan.forcedPolicy ?? opts.conflictPolicy,
    resolveConflict: plan.forcedPolicy
      ? undefined
      : resolveConflictFor(opts, targetName, plan.resourceType, plan.itemName),
    backupRootDir: plan.backupRootDir,
    now: opts.now,
  });
  if (outcome.record) {
    upsertLinkRecord(state, targetName, plan.resourceType, plan.itemName, outcome.record);
  }
  return outcome;
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
  // 列出全部指令文件（不施加"只能一份"约束），放多份时用户需要看到都有哪些才好删减
  resources[INSTRUCTIONS_TYPE] = await scanInstructions(storePath);
  return formatResourceList(resources);
}

/** 链接资源到目标 */
export async function runLink(targetArg: string, opts: CommandOptions): Promise<string> {
  const { storePath, config, state } = await loadContext(opts);
  const targetNames = resolveTargetNames(targetArg, config);
  const lines: string[] = [];
  let linked = 0, created = 0, conflicts = 0;
  const items = await scanResources(storePath, config);
  const instruction = await resolveInstruction(opts, storePath);

  for (const tName of targetNames) {
    for (const plan of buildLinkPlans(opts, config, tName, items, instruction)) {
      const outcome = await applyLinkPlan(plan, tName, storePath, state, opts);

      let status = '';
      switch (outcome.status) {
        case 'linked': status = 'linked'; linked++; break;
        case 'created': status = 'created'; created++; break;
        case 'backed-up': status = 'backed-up'; created++; break;
        case 'overwritten': status = 'overwritten'; created++; break;
        case 'conflict': status = 'conflict'; conflicts++; break;
      }

      lines.push(`${tName} ${plan.resourceType}/${plan.itemName} ${status} ${plan.targetPath}`);
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
  const instruction = await resolveInstruction(opts, storePath);
  const lines: string[] = [];

  for (const [tName, tState] of Object.entries(state.targets)) {
    const plans = buildLinkPlans(opts, config, tName, storeItems, instruction);

    // 当前 store 中的 items
    const plannedKeys = new Set<string>();
    for (const plan of plans) {
      plannedKeys.add(`${plan.resourceType}/${plan.itemName}`);
      const category = await classifyTarget(plan.targetPath, plan.sourcePath);
      lines.push(`${tName} ${plan.resourceType}/${plan.itemName} ${category} ${plan.targetPath}`);
    }

    // state 中已存在但 store 已删除（stale）
    for (const resourceType of stateResourceTypes(opts, config)) {
      if (!targetHandlesResource(config, tName, resourceType)) continue;
      for (const [itemName, record] of Object.entries(tState[resourceType] ?? {})) {
        if (plannedKeys.has(`${resourceType}/${itemName}`)) continue;
        lines.push(`${tName} ${resourceType}/${itemName} stale ${record.target}`);
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
  const instruction = await resolveInstruction(opts, storePath);

  for (const tName of targetNames) {
    const tState = state.targets[tName];

    // 1. 清理 stale：state 中有记录但 store 已无源
    for (const resourceType of stateResourceTypes(opts, config)) {
      if (!targetHandlesResource(config, tName, resourceType)) continue;
      const records = { ...(tState[resourceType] ?? {}) };
      for (const [itemName, record] of Object.entries(records)) {
        if (existsSync(record.source)) continue;
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
    for (const plan of buildLinkPlans(opts, config, tName, storeItems, instruction)) {
      const outcome = await applyLinkPlan(plan, tName, storePath, state, opts);
      const prefix = `${tName} ${plan.resourceType}/${plan.itemName}`;
      switch (outcome.status) {
        case 'linked':
          skipped++;
          lines.push(`${prefix} linked ${plan.targetPath}`);
          break;
        case 'created':
          created++;
          lines.push(`${prefix} created ${plan.targetPath}`);
          break;
        case 'backed-up':
          created++;
          lines.push(`${prefix} backed-up ${plan.targetPath}`);
          break;
        case 'overwritten':
          created++;
          lines.push(`${prefix} overwritten ${plan.targetPath}`);
          break;
        case 'conflict':
          conflicts++;
          lines.push(`${prefix} conflict ${plan.targetPath}`);
          break;
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
    for (const resourceType of stateResourceTypes(opts, config)) {
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
