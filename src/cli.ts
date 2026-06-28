#!/usr/bin/env node
/** dak CLI 入口 */

import { runInit, runList, runLink, runStatus, runUpdate, runUnlink } from './commands.js';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { assertSafeItemName } from './paths.js';
import type { ConflictPolicy } from './types.js';

/** 解析后的 argv */
export interface ParsedArgs {
  command: 'init' | 'list' | 'link' | 'status' | 'update' | 'unlink';
  target?: string;
  store?: string;
  onConflict?: 'skip' | 'backup' | 'overwrite';
  /** 限定单资源类型（含 config 声明的自定义类型），仅 link/unlink/status/update 生效 */
  resource?: string;
}

/** 解析命令行参数（不引入额外依赖） */
export function parseArgv(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { command: 'list' };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--store') {
      const val = argv[i + 1];
      if (!val) throw new Error('--store requires a value');
      result.store = val;
      i++;
      continue;
    }

    if (arg === '--on-conflict') {
      const val = argv[i + 1];
      if (!val) throw new Error('--on-conflict requires a value');
      if (!['skip', 'backup', 'overwrite'].includes(val)) {
        throw new Error('Invalid conflict policy');
      }
      result.onConflict = val as ParsedArgs['onConflict'];
      i++;
      continue;
    }

    // 限定单资源类型：-r / --resource <name>（自定义类型需在 config.resourceTypes 声明）
    if (arg === '--resource' || arg === '-r') {
      const val = argv[i + 1];
      if (!val) throw new Error('--resource requires a value');
      try {
        assertSafeItemName(val);
      } catch {
        throw new Error('Invalid resource type');
      }
      result.resource = val;
      i++;
      continue;
    }

    // 第一个非 flag 参数为命令或 target
    if (!arg.startsWith('--')) {
      const cmd = arg as ParsedArgs['command'];
      if (['init', 'list', 'link', 'status', 'update', 'unlink'].includes(cmd)) {
        result.command = cmd;
        // link/unlink 后跟 target
        if (cmd === 'link' || cmd === 'unlink') {
          const next = argv[i + 1];
          if (!next || next.startsWith('--')) {
            throw new Error(`${cmd} target is required`);
          }
          result.target = next;
          i++;
        }
      } else {
        throw new Error(`Unknown command: ${arg}`);
      }
    }
  }

  // link/unlink 必须有 target
  if ((result.command === 'link' || result.command === 'unlink') && !result.target) {
    throw new Error(`${result.command} target is required`);
  }

  return result;
}

/**
 * 交互式询问冲突策略（readline/promises）。
 * 仅在 TTY 下由 main 注入。输入无效时默认 skip。
 */
async function chooseConflictInteractive(
  target: string,
  resource: string,
  item: string,
): Promise<ConflictPolicy> {
  const rl = createInterface({ input, output });
  try {
    const prompt = `Conflict at ${target} ${resource}/${item}. Choose [s]kip/[b]ackup/[o]verwrite (default skip): `;
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    if (answer === 'b' || answer === 'backup') return 'backup';
    if (answer === 'o' || answer === 'overwrite') return 'overwrite';
    return 'skip';
  } finally {
    rl.close();
  }
}

/** 主入口 */
export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  const homeDir = process.env.HOME ?? '';
  const interactive = process.stdin.isTTY && process.stdout.isTTY;

  try {
    const parsed = parseArgv(args);
    const opts: any = { store: parsed.store, homeDir };
    if (parsed.resource) opts.resource = parsed.resource;

    // 冲突策略
    if (parsed.onConflict) {
      opts.conflictPolicy = parsed.onConflict;
    } else if (interactive) {
      opts.interactive = true;
      opts.chooseConflict = (target: string, resource: string, item: string): Promise<ConflictPolicy> => {
        return chooseConflictInteractive(target, resource, item);
      };
    }

    switch (parsed.command) {
      case 'init':
        console.log(await runInit(opts));
        break;
      case 'list':
        console.log(await runList(opts));
        break;
      case 'link':
        console.log(await runLink(parsed.target!, opts));
        break;
      case 'status':
        console.log(await runStatus(opts));
        break;
      case 'update':
        console.log(await runUpdate(opts));
        break;
      case 'unlink':
        console.log(await runUnlink(parsed.target!, opts));
        break;
    }

    return 0;
  } catch (e: any) {
    console.error(`Error: ${e.message}`);
    return 1;
  }
}

// 直接运行时执行 main
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
const __filename = fileURLToPath(import.meta.url);
// process.argv[1] 在通过 bin 软链接调用时仍是软链接路径，
// 而 import.meta.url 会被 Node 解析为真实路径。
// 用 realpathSync 把 argv[1] 也解析到真身后再比较，否则软链接调用时 main() 永不执行。
const invokedFrom = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invokedFrom === __filename) {
  (async () => {
    const code = await main();
    process.exit(code);
  })();
}
