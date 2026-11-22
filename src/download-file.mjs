// 通用 HTTP 流式下载（带速度/ETA 回调与中止支持），用于自定义引擎拿到的直链
import { createWriteStream, renameSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/**
 * 下载直链到 dest。urls 传数组时依次尝试（多 CDN 镜像容灾）。
 * onProgress: ({percent, done, total, speed, eta})  speed 单位 字节/秒
 * signal: AbortSignal，触发后中止当前请求（.part 保留，恢复时从头下）
 * @returns {Promise<{path: string, size: number}>}
 */
export async function downloadFile(urls, dest, { onProgress, headers = {}, signal } = {}) {
  const list = Array.isArray(urls) ? urls : [urls];
  let lastErr;
  for (const url of list) {
    try {
      if (signal?.aborted) throw abortError();
      const res = await fetch(url, {
        headers: { 'user-agent': BROWSER_UA, ...headers },
        redirect: 'follow',
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      let done = 0;
      let speed = 0; // 字节/秒（滑窗 + EMA 平滑）
      let winBytes = 0;
      let lastTick = Date.now();
      const tmp = `${dest}.part`;
      const body = Readable.fromWeb(res.body);
      body.on('data', (chunk) => {
        done += chunk.length;
        winBytes += chunk.length;
        const now = Date.now();
        const dt = (now - lastTick) / 1000;
        if (dt >= 0.4) {
          const inst = winBytes / dt;
          speed = speed ? speed * 0.5 + inst * 0.5 : inst;
          winBytes = 0;
          lastTick = now;
        }
        const pct = total ? (done / total) * 100 : -1;
        const eta = total && speed > 0 ? Math.max(0, Math.round((total - done) / speed)) : -1;
        onProgress?.({ percent: pct, done, total, speed, eta });
      });
      await pipeline(body, createWriteStream(tmp));
      renameSync(tmp, dest);
      onProgress?.({ percent: 100, done, total: total || done, speed, eta: 0 });
      return { path: dest, size: done };
    } catch (err) {
      rmSync(`${dest}.part`, { force: true });
      if (isAbort(err)) throw abortError();
      lastErr = err;
    }
  }
  throw new Error(`全部地址下载失败: ${lastErr?.message}`);
}

function isAbort(err) {
  return err?.name === 'AbortError' || /aborted|abort/i.test(String(err?.message || ''));
}
function abortError() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}
