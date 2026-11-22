// 下载历史持久化（history.json）：已完成任务的元数据（原始链接/目标路径/标题等），
// 服务重启后自动回填任务列表。打包版通过 VD_HISTORY_PATH 指到用户数据目录。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.env.VD_HISTORY_PATH || path.join(ROOT, 'history.json');
const MAX_RECORDS = 500;

export function loadHistory(file = FILE) {
  try {
    const arr = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(arr) ? arr.slice(-MAX_RECORDS) : [];
  } catch {
    return [];
  }
}

/** 追加/覆盖一条记录（同 id 去重，保留最新），超出上限裁掉最旧的 */
export function appendHistory(record, file = FILE) {
  const all = loadHistory(file).filter((r) => r.id !== record.id);
  all.push(record);
  writeFileSync(file, JSON.stringify(all.slice(-MAX_RECORDS), null, 2), 'utf8');
  return record;
}
