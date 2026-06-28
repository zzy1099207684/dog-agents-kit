/** dak 核心类型定义 */

/** 默认资源类型；自定义类型在 config.resourceTypes 中声明 */
export const DEFAULT_RESOURCE_TYPES = ['skills', 'hooks', 'agents'] as const;
/** 资源类型：字面量由 config 显式声明，运行期为 string */
export type ResourceType = string;

/** 冲突处理策略 */
export const CONFLICT_POLICIES = ['skip', 'backup', 'overwrite'] as const;
export type ConflictPolicy = (typeof CONFLICT_POLICIES)[number];

/** 全局配置 */
export interface DakConfig {
  /** 资源仓库目录 */
  store: string;
  /** 全部受管理的资源类型（含自定义）；缺失回退 DEFAULT_RESOURCE_TYPES */
  resourceTypes?: string[];
  /** 各目标工具的配置 */
  targets: Record<string, TargetConfig>;
}

/** 单个目标工具的配置 */
export interface TargetConfig {
  /** 工具根目录 */
  path: string;
  /** 各资源类型在目标中的子路径 */
  resources?: Partial<Record<ResourceType, string>>;
}

/** 持久化状态 */
export interface DakState {
  version: number;
  targets: Record<string, TargetState>;
}

/** 单个目标工具的资源链接状态（key 为资源类型） */
export interface TargetState {
  [resourceType: string]: Record<string, LinkRecord>;
}

/** 单条资源链接记录 */
export interface LinkRecord {
  /** 资源在仓库中的相对路径 */
  source: string;
  /** 目标工具中的绝对链接路径 */
  target: string;
  /** 链接创建时间（ISO 字符串） */
  linkedAt: string;
}

/** 资源目录项 */
export interface ResourceItem {
  name: string;
  kind: 'file' | 'directory' | 'symlink';
  path: string;
}
