// MissAV 自定义引擎：Cloudflare 防护 + HLS 流
// 无头 Edge 加载页面（过 CF）→ 页面上下文提取 m3u8（DOM/performance/JS 变量）→ yt-dlp 下载 HLS
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withPage, evalInPage } from './headless-edge.mjs';
import { SOURCE_PRINT_ARGS, createSourceCollector, emitSource } from './stream-source.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BIN_DIR = path.join(ROOT, 'bin');
const YTDLP = path.join(BIN_DIR, 'yt-dlp.exe');
const FFMPEG = path.join(BIN_DIR, 'ffmpeg.exe');

const PAGE_JS = `(() => {
  try {
    const title = (document.title || '').replace(/\\s*[|-]\\s*(MissAV|missav).*$/i, '').trim() || document.title || '';
    // 方式1: video 元素（可能已加载了源）
    const video = document.querySelector('video');
    const videoSrc = (video && (video.src || (video.querySelector('source') && video.querySelector('source').src))) || '';
    // 方式2: performance API 列出所有网络请求，找 .m3u8
    let perfM3u8 = '';
    try {
      const res = performance.getEntriesByType('resource');
      for (const r of res) {
        if (r.name && r.name.includes('.m3u8') && !r.name.includes('blob:')) {
          perfM3u8 = r.name;
          break;
        }
      }
    } catch (e) {}
    // 方式3: SSR/框架数据
    let dataM3u8 = '';
    const nuxt = window.__NUXT__ || window.__NEXT_DATA__;
    if (nuxt) {
      try {
        const s = JSON.stringify(nuxt);
        const m = s.match(/https?:[^"'\\\\]+\\.m3u8[^"'\\\\]*/);
        if (m) dataM3u8 = m[0].replace(/\\\\\\//g, '/');
      } catch (e) {}
    }
    // 方式4: 遍历 script 文本
    let scriptM3u8 = '';
    if (!perfM3u8 && !dataM3u8) {
      for (const sc of document.querySelectorAll('script')) {
        const t = sc.textContent || '';
        const m = t.match(/https?:[^"'\\s]+\\.m3u8[^"'\\s]*/);
        if (m) { scriptM3u8 = m[0]; break; }
      }
    }
    return JSON.stringify({
      title,
      videoSrc,
      perfM3u8,
      dataM3u8,
      scriptM3u8,
      pageUrl: location.href,
      readyState: document.readyState,
    });
  } catch (e) {
    return JSON.stringify({ err: String(e) });
  }
})()`;

/**
 * 下载 MissAV 视频（也适用于其他 Cloudflare+HLS 站点模式）。
 * 事件协议与 douyin/xiaohongshu 引擎一致。
 */
export async function downloadMissav(url, opts = {}) {
  const { outDir, onEvent } = opts;
  mkdirSync(outDir, { recursive: true });

  onEvent?.({ type: 'info', raw: '[missav] 正在通过 Cloudflare 验证…（约 10-15 秒）' });

  // 无头 Edge 加载页面（等 Cloudflare 挑战 + 播放器初始化）
  const raw = await withPage(
    url,
    async ({ cdp, sessionId }) => evalInPage(cdp, sessionId, PAGE_JS),
    { settleMs: 8000 }, // 额外等 8 秒给播放器加载
  );
  const info = typeof raw === 'string' ? JSON.parse(raw) : raw;

  if (info.err) throw new Error(`missav: ${info.err}`);

  // 依次尝试各来源的 m3u8
  const m3u8 = info.perfM3u8 || info.dataM3u8 || info.scriptM3u8;
  if (!m3u8) {
    throw new Error(
      `missav: 未能提取到视频流地址（readyState=${info.readyState}, videoSrc=${info.videoSrc?.slice(0, 30) || '无'}）`,
    );
  }

  const title = sanitizeName(info.title);
  onEvent?.({ type: 'title', title });
  onEvent?.({ type: 'info', raw: `[missav] 《${title}》 已获取 HLS 流，开始下载…` });

  // 用 yt-dlp 下载 HLS（原生 m3u8 支持，ffmpeg 合并分段）
  const args = [
    m3u8,
    '-f', 'bv*+ba/b',
    '--merge-output-format', 'mp4',
    '-o', path.join(outDir, `${title}.%(ext)s`),
    '--encoding', 'utf-8',
    '--ffmpeg-location', FFMPEG,
    '--retries', '10',
    '--fragment-retries', '10',
    '--newline', '--progress',
    '--no-simulate',
    '--print', 'after_move:%(filepath)s',
    ...SOURCE_PRINT_ARGS, // 下载前输出选中的格式：视频流真正的地址（域名 / IP），详情里显示
    '--add-headers', `Referer: ${url}`,
    '--add-headers', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  ];

  const files = [];
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, args, {
      windowsHide: true,
      env: {
        ...process.env,
        PATH: `${BIN_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
    });
    let buf = '';
    // 视频流地址：yt-dlp 在下载前打印，一组收齐就发给界面（不等它，下载照常进行）
    const feedSource = createSourceCollector();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) {
        const t = l.trim();
        if (!t) continue;
        const streams = feedSource(t);
        if (streams !== undefined) {
          if (streams) emitSource(onEvent, streams);
          continue;
        }
        const m = t.match(/^\[download\]\s+(\d+(?:\.\d+)?)%/);
        if (m) {
          // 解析速度/ETA/总量（与主引擎 parseProgressDetail 同逻辑，避免循环依赖）
          const dm = t.match(/of\s+~?\s*([\d.]+)\s*(KiB|MiB|GiB)(?:.*?at\s+([\d.]+)\s*(KiB|MiB|GiB)\/s)?(?:.*?ETA\s+([\d:]+))?/i);
          const UNIT = { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };
          const detail = dm ? {
            total: Number(dm[1]) * (UNIT[dm[2]] || 1),
            speed: dm[3] ? Number(dm[3]) * (UNIT[dm[4]] || 1) : null,
            eta: dm[5] ? dm[5].split(':').reverse().reduce((a, p, i) => a + Number(p) * 60 ** i, 0) : null,
          } : {};
          onEvent?.({ type: 'progress', percent: parseFloat(m[1]), raw: t, ...detail });
        } else if (!t.startsWith('[') && existsSync(t)) {
          files.push(t);
          onEvent?.({ type: 'file', file: t });
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => {
      const t = c.trim();
      if (t.startsWith('ERROR')) onEvent?.({ type: 'log', raw: t });
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ url, files });
      else reject(new Error(`yt-dlp 退出码 ${code}（HLS 下载失败，地址可能已过期）`));
    });
  });
}

function sanitizeName(s) {
  return (
    String(s || '')
      .replace(/[\\/:*?"<>|#\r\n\t]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .slice(0, 100) || 'missav_video'
  );
}
