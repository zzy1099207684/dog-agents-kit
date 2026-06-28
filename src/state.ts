/** 状态读写 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_FILE } from './constants.js';
import { declaredResourceTypes } from './config.js';
import type { DakConfig, DakState, LinkRecord, ResourceType } from './types.js';

/** 空状态 */
const EMPTY_STATE: DakState = { version: 1, targets: {} };

/**
 * 读取状态文件，不存在时返回空状态。
 */
export async function readState(storePath: string): Promise<DakState> {
  const statePath = join(storePath, STATE_FILE);
  if (!existsSync(statePath)) return EMPTY_STATE;
  const raw = await readFile(statePath, 'utf-8');
  const state = JSON.parse(raw) as DakState;
  if (state.version !== 1) {
    throw new Error(`unsupported state version: ${state.version}`);
  }
  return state;
}

/**
 * 写入状态文件。
 */
export async function writeState(storePath: string, state: DakState): Promise<void> {
  const statePath = join(storePath, STATE_FILE);
  await mkdir(storePath, { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * 确保状态文件存在（不存在则创建空状态）。
 */
export async function writeStateIfMissing(storePath: string): Promise<void> {
  const statePath = join(storePath, STATE_FILE);
  if (existsSync(statePath)) return;
  await writeState(storePath, EMPTY_STATE);
}

/**
 * 确保目标 state 存在，并补齐声明的各资源类型 map。
 * 旧 state 缺失新声明的类型时补空 map；不删除已有 key。
 */
export function ensureTargetState(state: DakState, targetName: string, config: DakConfig): DakState {
  if (!state.targets[targetName]) {
    state.targets[targetName] = {};
  }
  const targetState = state.targets[targetName];
  for (const type of declaredResourceTypes(config)) {
    if (!targetState[type]) {
      targetState[type] = {};
    }
  }
  return state;
}

/**
 * 确保 target 容器与指定资源类型的 map 存在（惰性创建）。
 */
function ensureResourceMap(
  state: DakState,
  targetName: string,
  resourceType: ResourceType,
): DakState {
  if (!state.targets[targetName]) {
    state.targets[targetName] = {};
  }
  if (!state.targets[targetName][resourceType]) {
    state.targets[targetName][resourceType] = {};
  }
  return state;
}

/**
 * 替换某个 target/resource 的所有 records。
 */
export function replaceTargetResourceState(
  state: DakState,
  targetName: string,
  resourceType: ResourceType,
  records: Record<string, LinkRecord>,
): DakState {
  ensureResourceMap(state, targetName, resourceType);
  state.targets[targetName][resourceType] = records;
  return state;
}

/**
 * 新增或更新单条 record。
 */
export function upsertLinkRecord(
  state: DakState,
  targetName: string,
  resourceType: ResourceType,
  itemName: string,
  record: LinkRecord,
): DakState {
  ensureResourceMap(state, targetName, resourceType);
  state.targets[targetName][resourceType][itemName] = record;
  return state;
}

/**
 * 删除单条 record，返回是否删除成功（存在才删）。
 */
export function removeLinkRecord(
  state: DakState,
  targetName: string,
  resourceType: ResourceType,
  itemName: string,
): DakState {
  if (state.targets[targetName]?.[resourceType]) {
    delete state.targets[targetName][resourceType][itemName];
  }
  return state;
}

/**
 * 从 state 中移除整个 target 的 state。
 */
export function removeTargetState(state: DakState, targetName: string): DakState {
  delete state.targets[targetName];
  return state;
}
