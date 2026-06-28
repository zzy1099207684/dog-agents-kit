/** symlink 引擎与冲突策略 */

import { mkdir, unlink, rename, lstat, readlink, stat } from 'node:fs/promises';
import { symlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { resolveLinkTarget, realParentJoined, isPathInside } from './paths.js';
import type { LinkRecord, ConflictPolicy } from './types.js';

/** 目标分类结果 */
export type TargetCategory = 'missing' | 'linked' | 'broken' | 'conflict';

/** 链接结果状态 */
export type LinkStatus =
  | 'linked'
  | 'created'
  | 'backed-up'
  | 'overwritten'
  | 'conflict';

/** 链接操作结果 */
export interface LinkOutcome {
  status: LinkStatus;
  record?: LinkRecord;
}

/** linkItem 输入 */
export interface LinkItemInput {
  sourcePath: string;
  targetPath: string;
  resourceType: string;
  itemName: string;
  storePath: string;
  /** 静态策略；与 resolveConflict 二选一。无 resolver 时直接用此值。 */
  policy?: 'skip' | 'backup' | 'overwrite';
  /**
   * 交互式冲突解析器。仅当目标真实冲突（conflict/broken）时才回调；
   * missing/linked 不会触发，避免无冲突仍逐项提问。
   * 未提供时回退到 policy（默认 skip）。
   */
  resolveConflict?: () => Promise<ConflictPolicy> | ConflictPolicy;
  now?: Date;
}

/**
 * 解析 symlink 的逻辑目标绝对路径（不跟随 symlink，不依赖目标存在）。
 * 用 readlink 取原始 target，再用 resolveLinkTarget 按链接父目录解析。
 * 断链 symlink 也能解析，因为它不 stat 目标。
 */
async function logicalSymlinkTarget(linkPath: string): Promise<string> {
  const raw = await readlink(linkPath);
  return resolveLinkTarget(linkPath, raw);
}

/**
 * 分类目标路径状态。
 * - lstat 判存在：ENOENT → missing；非 symlink → conflict。
 * - stat 跟随 symlink 判目标是否存在：不存在 → broken。
 * - readlink 逻辑解析与 expectedSource 比较（不 realpath），避免 store 处于
 *   symlink 后方时假 conflict：相等 → linked，否则 → conflict。
 */
export async function classifyTarget(
  targetPath: string,
  expectedSource: string,
): Promise<TargetCategory> {
  let linkStat;
  try {
    linkStat = await lstat(targetPath);
  } catch (e: any) {
    if (e?.code === 'ENOENT') return 'missing';
    throw e;
  }
  if (!linkStat.isSymbolicLink()) return 'conflict';

  // 目标不存在（断链）
  try {
    await stat(targetPath);
  } catch (e: any) {
    if (e?.code === 'ENOENT') return 'broken';
    throw e;
  }

  try {
    const logicalTarget = await logicalSymlinkTarget(targetPath);
    if (logicalTarget === expectedSource) return 'linked';
    return 'conflict';
  } catch {
    return 'broken';
  }
}

/**
 * 创建相对 symlink（Linux/macOS）。
 * Windows 目录 junction 另做处理，这里先实现相对 symlink。
 */
async function createRelativeSymlink(sourcePath: string, targetPath: string): Promise<void> {
  const targetParent = await realParentJoined(dirname(targetPath));
  const rel = relative(targetParent, sourcePath);
  // 确保父目录存在
  await mkdir(dirname(targetPath), { recursive: true });
  // Windows 下目录 symlink 需要权限，这里统一用 symlink
  symlinkSync(rel, targetPath);
}

/**
 * 移动旧内容到备份目录。
 * 备份根目录 = 目标 resource 根目录的父目录（即 target 根目录）下 .dak-backup。
 * 时间戳格式固定为 YYYYMMDDTHHmmssSSSZ（UTC）。
 */
async function moveToBackup(
  targetPath: string,
  storePath: string,
  resourceType: string,
  itemName: string,
  now: Date,
): Promise<string> {
  const ts = formatBackupTimestamp(now);
  // targetPath = <targetRoot>/<resourceType>/<item>
  // resource root parent = targetRoot = dirname(dirname(targetPath))
  const targetRoot = dirname(dirname(targetPath));
  const backupRoot = join(targetRoot, '.dak-backup');
  const backupPath = join(backupRoot, ts, resourceType, itemName);
  await mkdir(dirname(backupPath), { recursive: true });
  await rename(targetPath, backupPath);
  return backupPath;
}

/**
 * 格式化备份时间戳为 YYYYMMDDTHHmmssSSSZ（UTC），不带分隔符。
 */
function formatBackupTimestamp(now: Date): string {
  const iso = now.toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ
  return iso.replace(/[-:]/g, '').replace('.', '');
}

/**
 * 执行链接操作。
 * linked 时也返回 record，供上层刷新 state（linkedAt/source 可能需要校正）。
 */
export async function linkItem(input: LinkItemInput): Promise<LinkOutcome> {
  const { sourcePath, targetPath, resourceType, itemName, storePath, resolveConflict, now } = input;
  const category = await classifyTarget(targetPath, sourcePath);
  const timestamp = now ?? new Date();
  const record: LinkRecord = {
    source: sourcePath,
    target: targetPath,
    linkedAt: timestamp.toISOString(),
  };

  if (category === 'linked') {
    return { status: 'linked', record };
  }

  let policy: 'skip' | 'backup' | 'overwrite';
  if (category === 'conflict' || category === 'broken') {
    // 仅真实冲突才解析策略：有 resolver 就问，否则回退静态 policy（默认 skip）
    if (resolveConflict) {
      policy = await resolveConflict();
    } else {
      policy = input.policy ?? 'skip';
    }
    if (policy === 'skip') {
      return { status: 'conflict' };
    }
    // 删除旧内容（broken symlink 或真实文件）
    if (policy === 'backup') {
      await moveToBackup(targetPath, storePath, resourceType, itemName, timestamp);
    } else if (policy === 'overwrite') {
      try {
        await unlink(targetPath);
      } catch {
        // 可能不存在或已被删除，忽略
      }
    }
  } else {
    // missing：直接创建，无需策略
    policy = 'skip';
  }

  // 创建新链接
  await createRelativeSymlink(sourcePath, targetPath);

  return {
    status: category === 'missing' ? 'created' : policy === 'backup' ? 'backed-up' : 'overwritten',
    record,
  };
}

/**
 * 安全删除 dak 管理的 symlink。
 * 用 lstat 判存在（断链 symlink 也成功），用 readlink 逻辑解析比较：
 * - target 不存在（lstat 抛 ENOENT）：missing
 * - target 不是 symlink：conflict
 * - 逻辑目标不在当前 store 内：conflict
 * - 逻辑目标不等于 record.source：conflict
 * 满足全部条件才 unlink。断链 symlink 也能被删除（source 已删，逻辑目标仍可解析）。
 */
export async function safeDeleteManagedLink(
  record: LinkRecord,
  storePath: string,
): Promise<'deleted' | 'missing' | 'conflict'> {
  const { target, source } = record;

  let linkStat;
  try {
    linkStat = await lstat(target);
  } catch (e: any) {
    if (e?.code === 'ENOENT') return 'missing';
    throw e;
  }
  if (!linkStat.isSymbolicLink()) return 'conflict';

  let logicalTarget: string;
  try {
    logicalTarget = await logicalSymlinkTarget(target);
  } catch {
    return 'conflict';
  }

  // 检查是否指向当前 store
  if (!isPathInside(logicalTarget, storePath)) return 'conflict';

  // 检查是否指向 record.source
  if (logicalTarget !== source) return 'conflict';

  await unlink(target);
  return 'deleted';
}
