// 全局配置（config.json，项目根目录，gitignore；打包版在用户数据目录）
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 测试/打包版可用 VD_CONFIG_PATH 指定（测试隔离临时配置、打包版指用户数据目录）
const FILE = process.env.VD_CONFIG_PATH || path.join(ROOT, 'config.json');

// maxParallel：同时下载的任务数（默认 3 个，设置里可调）
const DEFAULTS = { proxy: '', bilibiliSessdata: '', hlsSites: [], maxParallel: 3 };

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

/**
 * 归一化 HLS 站点域名列表（供设置面板与 API 共用）：
 * 接受数组或换行/逗号分隔文本；去 scheme、路径、前导 www.；小写；去重；非法项丢弃。
 */
export function normalizeHlsSites(input) {
  const arr = Array.isArray(input) ? input : String(input || '').split(/[\n,;]+/);
  const out = [];
  for (const raw of arr) {
    let d = String(raw).trim().toLowerCase();
    if (!d) continue;
    // 去 scheme、去前导 www.、截掉路径/查询、去首尾点
    d = d.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0].replace(/^\.+|\.+$/g, '');
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && !out.includes(d)) out.push(d);
  }
  return out;
}
