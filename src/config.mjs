// 全局配置（config.json，项目根目录，gitignore；打包版在用户数据目录）
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 测试/打包版可用 VD_CONFIG_PATH 指定（测试隔离临时配置、打包版指用户数据目录）
const FILE = process.env.VD_CONFIG_PATH || path.join(ROOT, 'config.json');

const DEFAULTS = { proxy: '', bilibiliSessdata: '' };

export function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(FILE, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(patch) {
  const merged = { ...loadConfig(), ...patch };
  writeFileSync(FILE, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}

/** 支持 http:// https:// socks4:// socks4a:// socks5:// socks5h:// 或空串 */
export function isValidProxy(p) {
  return /^(https?|socks[45]a?h?):\/\/[^\s]+$/.test(String(p || '').trim()) || String(p || '').trim() === '';
}
