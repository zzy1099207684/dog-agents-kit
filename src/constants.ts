/** dak 常量定义 */

import type { DakConfig } from './types.js';
import { DEFAULT_RESOURCE_TYPES } from './types.js';

/** 默认资源仓库目录 */
export const DEFAULT_STORE = '~/.dog-agents-kit';

/** 配置文件文件名 */
export const CONFIG_FILE = 'dak.config.json';

/** 状态文件名 */
export const STATE_FILE = '.dak-state.json';

/** 默认配置 */
export const DEFAULT_CONFIG: DakConfig = {
  store: DEFAULT_STORE,
  resourceTypes: [...DEFAULT_RESOURCE_TYPES],
  targets: {
    'codex': {
      path: '~/.codex',
      resources: { skills: 'skills', hooks: 'hooks', agents: 'agents' },
    },
    'claudecode': {
      path: '~/.claude',
      resources: { skills: 'skills', hooks: 'hooks', agents: 'agents' },
    },
  },
};
