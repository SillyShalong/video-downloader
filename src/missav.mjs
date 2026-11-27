// HLS 站点引擎：Cloudflare 防护 + HLS 流
// 无头 Edge 加载页面（过 CF）→ 页面上下文提取 m3u8（DOM/performance/JS 变量）→ yt-dlp 下载 HLS
// （分段地址过期时保留断点，换新地址后从没下完的那一段接着下，见 downloadHlsStream）
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withPage, evalInPage } from './headless-edge.mjs';
import { SOURCE_PRINT_ARGS, createSourceCollector, emitSource } from './stream-source.mjs';
import { ytDlpName, ffmpegName, killTree } from './platform.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
 * 下载 HLS 流媒体站点的视频（无头 Edge 过 Cloudflare → 页面里提取 m3u8 → yt-dlp 下载 HLS）。
 * 也适用于其他「Cloudflare + HLS」模式的站点（域名在 config.json 的 hlsSites 里）。
 * 事件协议与 douyin/xiaohongshu 引擎一致。
 */
export async function downloadMissav(url, opts = {}) {
  const { outDir, onEvent, signal } = opts;
  mkdirSync(outDir, { recursive: true });

  /** 打开页面，找出播放列表地址和标题（播放列表地址自己过期时再调一次） */
  const openPage = async () => {
    onEvent?.({ type: 'info', raw: '[hls] 正在通过 Cloudflare 验证…（约 10-15 秒）' });
    // 无头 Edge 加载页面（等 Cloudflare 挑战 + 播放器初始化）
    const raw = await withPage(
      url,
      async ({ cdp, sessionId }) => evalInPage(cdp, sessionId, PAGE_JS),
      { settleMs: 8000 }, // 额外等 8 秒给播放器加载
    );
    const info = typeof raw === 'string' ? JSON.parse(raw) : raw;

    if (info.err) throw new Error(`hls: ${info.err}`);

    // 依次尝试各来源的 m3u8
    const m3u8 = info.perfM3u8 || info.dataM3u8 || info.scriptM3u8;
    if (!m3u8) {
      throw new Error(
        `hls: 未能提取到视频流地址（readyState=${info.readyState}, videoSrc=${info.videoSrc?.slice(0, 30) || '无'}）`,
      );
    }
    return { m3u8, title: sanitizeName(info.title) };
  };

  const first = await openPage();
  const title = first.title;
  onEvent?.({ type: 'title', title });
  onEvent?.({ type: 'info', raw: `[hls] 《${title}》 已获取 HLS 流，开始下载…` });

  let m3u8 = first.m3u8;
  return downloadHlsStream(
    // 播放列表地址。默认沿用上一次的：分段地址过期时，yt-dlp 重新读一遍播放列表就能拿到新的分段地址。
    // 连着一段都没往前走，才重新打开页面换个新的播放列表地址（它自己也可能过期了）
    async ({ refresh }) => {
      if (refresh) {
        onEvent?.({ type: 'info', raw: '[hls] 播放列表地址已失效，重新打开网页获取…' });
        m3u8 = (await openPage()).m3u8;
      }
      return m3u8;
    },
    { outDir, title, headers: { Referer: url, 'User-Agent': UA }, onEvent, signal },
  );
}

/**
 * yt-dlp / ffmpeg 在哪：打包版（Electron）放在 resources/bin，主进程用环境变量 VD_BIN_DIR 指过来；
 * 从源码运行时在项目的 bin/ 里。（调用时才读环境变量：主进程是先设好它、再加载业务模块的）
 */
export function hlsBinaries() {
  const dir = process.env.VD_BIN_DIR || path.join(ROOT, 'bin');
  return { ytdlp: path.join(dir, ytDlpName()), ffmpeg: path.join(dir, ffmpegName()) };
}

/**
 * 用 yt-dlp 下载一个 HLS 流，直到下完。
 *
 * 分段地址常常带有效期，过了时间服务器就回 403 / 410。yt-dlp 的原生 HLS 下载器默认把拿不到的分段当成
 * 「不存在」：跳过它，把后面的分段接着下完，最后以退出码 0 结束 —— 后面的分段用的多半是同一个过期的
 * token，于是全都跳过，得到一个只有前半截的文件，还被当成下载成功。
 * 所以这里让它「拿不到分段就停下」（--abort-on-unavailable-fragments）：已经下好的分段留在 .part 里，
 * 下到了第几段记在 .ytdl 里。停下了就换个播放列表地址再跑一次，它从没下完的那一段接着下，前面的不重下。
 *
 * @param {(opts: {refresh: boolean}) => (string|Promise<string>)} getPlaylist 播放列表地址。
 *   上一次一段都没往前走时 refresh 为 true（调用方最好换个新地址）
 * @returns {Promise<{files: string[]}>} 最终落盘的文件；下不完就抛错（不会留下当成成功的半截文件）
 */
export async function downloadHlsStream(getPlaylist, { outDir, title, headers = {}, onEvent, signal, backoffMs = 1500, ytdlp, ffmpeg } = {}) {
  const bins = ytdlp && ffmpeg ? { ytdlp, ffmpeg } : hlsBinaries();
  let stalled = 0; // 已经连续几次一段都没往前走
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw abortError();
    const before = hlsResumePoint(outDir, title);
    const playlist = await getPlaylist({ refresh: attempt > 1 && stalled > 0 });
    let err;
    try {
      return await runYtDlp(playlist, { outDir, title, headers, onEvent, signal, ...bins });
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') throw abortError();
      if (!RETRYABLE_ERR_RE.test(String(e?.message))) throw e;
      err = e;
    }
    if (signal?.aborted) throw abortError();

    const after = hlsResumePoint(outDir, title);
    const progressed = !!after && (!before || after.index > before.index || after.bytes > before.bytes);
    stalled = progressed ? 0 : stalled + 1;
    if (attempt >= MAX_ATTEMPTS || stalled >= MAX_STALLED) {
      const kept = after ? `已下好 ${after.index} 段，断点已保留，点「重试」会从这里继续` : '还没有下载到任何分段';
      throw new Error(`分段下载失败，重新获取地址后仍然不行（${kept}）\n${err.message}`);
    }
    onEvent?.({
      type: 'info',
      raw: progressed
        ? `分段没取到（${describe(err)}），重新读取播放列表，从第 ${after.index + 1} 段继续（第 ${attempt} 次重试）`
        : `分段没取到（${describe(err)}），重新获取地址后再试（第 ${attempt} 次重试）`,
    });
    await sleep(Math.min(backoffMs * attempt, backoffMs * 4));
  }
}

/** 最多一共跑这么多次 yt-dlp（每次都有进展的话就让它一直往下走） */
const MAX_ATTEMPTS = 20;
/** 连续这么多次「一段都没往前走」就放弃：换了新地址也没用，再试只是浪费时间 */
const MAX_STALLED = 3;
/**
 * 值得换个地址再试一次的错误：分段拿不到（地址过期）、瞬时网络错误。
 * 别的错误（找不到 ffmpeg、磁盘满……）重试也没用，直接报出来
 */
const RETRYABLE_ERR_RE =
  /fragment \d+ not found|HTTP Error (40[134]|42[99]|5\d\d)|timed?[- ]?out|connection (reset|refused|aborted|timed out)|Unable to download|temporary failure|ECONNRESET|EPIPE|IncompleteRead/i;

/** 报错里给用户看的原因：HTTP 状态码，或者 yt-dlp 的第一行报错 */
function describe(err) {
  const msg = String(err?.message ?? err);
  const code = /HTTP Error (\d{3})/.exec(msg);
  if (code) return `HTTP ${code[1]}`;
  return (msg.split('\n').find((l) => l.trim()) || '未知错误').replace(/^ERROR:\s*/, '').slice(0, 80);
}

/**
 * yt-dlp 留下的断点：下到了第几段（index，从 0 起）、已经下了多少字节。
 * 没在下载中（没有 .ytdl 文件，或者文件坏了）时返回 null。
 */
export function hlsResumePoint(outDir, title) {
  let names;
  try {
    names = readdirSync(outDir);
  } catch {
    return null;
  }
  const ytdl = names.find((n) => n.startsWith(`${title}.`) && n.endsWith('.ytdl'));
  if (!ytdl) return null;
  try {
    const index = JSON.parse(readFileSync(path.join(outDir, ytdl), 'utf8'))?.downloader?.current_fragment?.index;
    if (!Number.isInteger(index)) return null;
    const part = path.join(outDir, ytdl.slice(0, -'.ytdl'.length) + '.part');
    return { index, bytes: existsSync(part) ? statSync(part).size : 0 };
  } catch {
    return null;
  }
}

/** 跑一次 yt-dlp。成功返回 { files }；失败抛错（message 里带着 yt-dlp 的报错）；中止时抛 AbortError */
function runYtDlp(playlistUrl, { outDir, title, headers, onEvent, signal, ytdlp, ffmpeg }) {
  const args = [
    playlistUrl,
    '-f', 'bv*+ba/b',
    '--merge-output-format', 'mp4',
    '-o', path.join(outDir, `${title}.%(ext)s`),
    '--encoding', 'utf-8',
    '--ffmpeg-location', ffmpeg,
    '--retries', '10',
    '--fragment-retries', '10',
    // 拿不到分段就停下来报错，不要跳过它继续（见 downloadHlsStream）
    '--abort-on-unavailable-fragments',
    '--newline', '--progress',
    '--no-simulate',
    '--print', 'after_move:%(filepath)s',
    ...SOURCE_PRINT_ARGS, // 下载前输出选中的格式：视频流真正的地址（域名 / IP），详情里显示
    ...Object.entries(headers).flatMap(([k, v]) => ['--add-headers', `${k}: ${v}`]),
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(ytdlp, args, {
      windowsHide: true,
      env: {
        ...process.env,
        PATH: `${path.dirname(ytdlp)}${path.delimiter}${process.env.PATH ?? ''}`,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
    });
    // 暂停 / 终止：连子进程（合成阶段的 ffmpeg）一起结束。没下完的 .part / .ytdl 留着，下次接着下
    const onAbort = () => killTree(child);
    if (signal) {
      if (signal.aborted) killTree(child);
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const finish = (fn, value) => {
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };

    let buf = '';
    const files = [];
    const errors = []; // yt-dlp 的报错行（出错时带给用户看）
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
    let errBuf = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => {
      errBuf += c;
      const lines = errBuf.split(/\r?\n/);
      errBuf = lines.pop();
      for (const l of lines) {
        const t = l.trim();
        if (t.startsWith('ERROR')) {
          errors.push(t);
          onEvent?.({ type: 'log', raw: t });
        }
      }
    });
    child.on('error', (e) => finish(reject, new Error(`无法启动 yt-dlp（${ytdlp}）：${e.message}`)));
    child.on('close', (code) => {
      if (signal?.aborted) return finish(reject, abortError());
      if (code === 0) return finish(resolve, { files });
      finish(reject, new Error([...errors.slice(-3), `yt-dlp 退出码 ${code}（HLS 下载失败）`].join('\n')));
    });
  });
}

function abortError() {
  const e = new Error('已中止');
  e.name = 'AbortError';
  return e;
}

function sanitizeName(s) {
  return (
    String(s || '')
      .replace(/[\\/:*?"<>|#\r\n\t]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .slice(0, 100) || 'hls_video'
  );
}
