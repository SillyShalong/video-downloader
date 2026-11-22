// 通用 HTTP 流式下载（带进度回调），用于自定义引擎拿到的直链
import { createWriteStream, renameSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/**
 * 下载直链到 dest。urls 传数组时依次尝试（多 CDN 镜像容灾）。
 * @returns {Promise<string>} 最终文件路径
 */
export async function downloadFile(urls, dest, { onProgress, headers = {} } = {}) {
  const list = Array.isArray(urls) ? urls : [urls];
  let lastErr;
  for (const url of list) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': BROWSER_UA, ...headers },
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      let done = 0;
      let lastTick = 0;
      const tmp = `${dest}.part`;
      const body = Readable.fromWeb(res.body);
      body.on('data', (chunk) => {
        done += chunk.length;
        const now = Date.now();
        if (onProgress && now - lastTick > 200) {
          lastTick = now;
          const pct = total ? ((done / total) * 100).toFixed(1) : '?';
          onProgress({ percent: total ? parseFloat(pct) : -1, done, total, raw: `[download] ${pct}% of ${fmtSize(total)}` });
        }
      });
      await pipeline(body, createWriteStream(tmp));
      renameSync(tmp, dest);
      onProgress?.({ percent: 100, done, total, raw: `[download] 100% of ${fmtSize(total)}` });
      return dest;
    } catch (err) {
      lastErr = err;
      rmSync(`${dest}.part`, { force: true });
    }
  }
  throw new Error(`全部地址下载失败: ${lastErr?.message}`);
}

function fmtSize(n) {
  if (!n) return '未知大小';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(2)}${units[i]}`;
}
