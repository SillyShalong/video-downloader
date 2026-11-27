// 核心下载器：封装 yt-dlp 进程，解析进度并返回最终文件路径
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchSite } from './sites.mjs';
import { downloadDouyin } from './douyin.mjs';
import { downloadXiaohongshu } from './xiaohongshu.mjs';
import { downloadMissav } from './missav.mjs';
import { loadConfig } from './config.mjs';
import { SOURCE_PRINT_ARGS, createSourceCollector, emitSource } from './stream-source.mjs';
import { ytDlpName, ffmpegName, killTree } from './platform.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
// 打包版（Electron）通过环境变量指向 resources/bin 与系统下载目录
const BIN_DIR = process.env.VD_BIN_DIR || path.join(ROOT, 'bin');
const YTDLP = path.join(BIN_DIR, ytDlpName());
const FFMPEG = path.join(BIN_DIR, ffmpegName());
export const DEFAULT_OUT_DIR = process.env.VD_OUT_DIR || path.join(ROOT, 'downloads');

const OUTPUT_TEMPLATE = '%(title)s [%(id)s].%(ext)s';

const PROGRESS_RE = /^\[download\]\s+(\d+(?:\.\d+)?)%/;
// 速度/大小解析：`45.3% of ~ 10.00MiB at 1.50MiB/s ETA 00:05` 或 `100% of 10.00MiB in 00:00:04 at 1.50MiB/s`
const SPEED_RE =
  /of\s+~?\s*([\d.]+)\s*(KiB|MiB|GiB)(?:.*?at\s+([\d.]+)\s*(KiB|MiB|GiB)\/s)?(?:.*?ETA\s+([\d:]+))?/i;
const UNIT = { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };

/** 解析 yt-dlp 进度行中的总量/速度/ETA（无匹配字段返回 null） */
export function parseProgressDetail(line) {
  const m = line.match(SPEED_RE);
  if (!m) return null;
  const total = Number(m[1]) * (UNIT[m[2]] || 1);
  const speed = m[3] ? Number(m[3]) * (UNIT[m[4]] || 1) : null;
  let eta = null;
  if (m[5]) {
    eta = m[5].split(':').reverse().reduce((acc, part, i) => acc + Number(part) * 60 ** i, 0);
  }
  return { total, speed, eta };
}

/** 终止一个进程及其子进程树（跨平台实现见 platform.mjs） */

/**
 * 瞬时网络错误（可整层重试）：403/429/超时/连接中断等；还有「分段拿不到」（多半是分段地址过期了）。
 * 连接类的错误在中文系统上 yt-dlp 的报错是中文的（「积极拒绝…」），所以连系统错误码一起认
 */
const CONNECTION_RE = /connection\s*(reset|refused|aborted|timed out)|10054|10060|10061|Errno (?:104|110|111)/i;
const TRANSIENT_ERR_RE = new RegExp(
  `HTTP Error (40[33]|42[99])|fragment \\d+ not found|unable to download video data|timed?[- ]?out|${CONNECTION_RE.source}|Unable to connect to proxy|temporary failure|ECONNRESET|EPIPE|IncompleteRead`,
  'i',
);
/** 连不上站点：没配代理时，多半是这个站点在当前网络下根本到不了 */
const UNREACHABLE_ERR_RE = new RegExp(`timed?[- ]?out|${CONNECTION_RE.source}|temporary failure|getaddrinfo|SSL_ERROR|Unexpected EOF`, 'i');

/** 探测文件的视频编码与分辨率（ffmpeg -i） */
function probeVideo(file) {
  const r = spawnSync(FFMPEG, ['-i', file], { encoding: 'utf8', windowsHide: true });
  const out = r.stderr || '';
  const vcodec = out.match(/Video: ([a-zA-Z0-9]+)/)?.[1] ?? null;
  const dims = out.match(/, (\d{2,5})x(\d{2,5})[ ,]/);
  // 竖屏视频宽高互换，取长边作为"画质档位"
  const tier = dims ? Math.max(Number(dims[1]), Number(dims[2])) : 0;
  return { vcodec, tier };
}

/** 兼容性兜底：视频编码非 h264/hevc 且档位 ≤1080p 时转码 H.264，避免 Windows 自带播放器黑屏 */
async function ensurePlayableFiles(files, emit) {
  for (const file of files) {
    if (!/\.(mp4|mkv|webm)$/i.test(file)) continue; // 纯音频等
    const { vcodec, tier } = probeVideo(file);
    if (!vcodec || /^(h264|hevc)/.test(vcodec)) continue;
    if (tier > 1080) {
      emit({ type: 'info', raw: `[compat] 保留原始编码 ${vcodec}（超高清流无 H.264 版本，如无法播放请用 VLC 播放）` });
      continue;
    }
    emit({ type: 'info', raw: `[compat] 检测到 ${vcodec} 编码，转码为 H.264 保证播放兼容性 ...` });
    const tmp = `${file}.transcode.mp4`;
    await new Promise((resolve, reject) => {
      const p = spawn(
        FFMPEG,
        ['-y', '-i', file, '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-c:a', 'copy', '-movflags', '+faststart', tmp],
        { windowsHide: true, stdio: 'ignore' },
      );
      p.on('error', reject);
      p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg 转码失败（退出码 ${c}）`))));
    });
    renameSync(tmp, file);
    emit({ type: 'info', raw: `[compat] ✔ 转码完成` });
  }
}

export function buildArgs(url, opts = {}) {
  const { outDir = DEFAULT_OUT_DIR, quality, audioOnly, proxy, bilibiliSessdata, playlistItems, extraArgs = [] } = opts;
  const site = matchSite(url);

  const args = [
    url,
    '--newline',
    '--progress',
    '--print', 'before_dl:__TITLE__%(title)s', // 下载前输出标题（带标记前缀）
    '--print', 'after_move:%(filepath)s', // 下载完成后输出最终文件路径
    ...SOURCE_PRINT_ARGS, // 下载前输出选中的格式：视频流真正的地址（域名 / IP），详情里显示
    '--no-simulate',
    '--encoding', 'utf-8', // 输出用 UTF-8，避免中文/emoji 路径被 GBK 破坏
    '-o', path.join(outDir, OUTPUT_TEMPLATE),
    '--ffmpeg-location', FFMPEG,
    '--retries', '10',
    '--fragment-retries', '10',
    '--extractor-retries', '3',
    // 分段流（HLS / DASH）里有一段拿不到时，让 yt-dlp 停下来报错，而不是把这一段跳过接着下：
    // 分段地址常常带有效期，过期后后面的分段全都拿不到，默认行为会把它们全部跳过，
    // 最后以「成功」收场 —— 文件却只有前半截。停下来之后下载器会换一批新地址重跑，从没下完的那一段接着下（见 downloadViaYtDlp）
    '--abort-on-unavailable-fragments',
  ];

  if (proxy) args.push('--proxy', proxy); // http/socks 均支持

  // 多视频源：用户选中的分集（1-based 序号列表，如 [1,3,5] → "1,3,5"）
  if (Array.isArray(playlistItems) && playlistItems.length > 0) {
    args.push('--playlist-items', playlistItems.map(Number).filter(Number.isInteger).join(','));
  }

  // B 站登录态（解锁 720p+）：SESSDATA 来自浏览器 Cookie，手动复制一次即可
  if (site?.id === 'bilibili' && bilibiliSessdata) {
    args.push('--add-headers', `Cookie: SESSDATA=${bilibiliSessdata}`);
  }

  if (audioOnly) {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else {
    let fmt = site?.format;
    if (quality) {
      // 优先「纯视频 + 纯音频」两路（画质好）；没有的话退到音视频合一的一路，但同样只挑不超过所选清晰度的。
      // 最后那个不带限制的 b 只在「这个站点根本没有这么低的清晰度」时才会用上
      fmt = `bv*[height<=${quality}][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[height<=${quality}]+ba/b[height<=${quality}]/b`;
    }
    args.push('-f', fmt ?? 'bv*+ba/b');
    if (site?.mergeFormat) args.push('--merge-output-format', site.mergeFormat);
  }

  args.push(...extraArgs);
  return args;
}

/**
 * 探测 URL 是否含多个视频源（播放列表/合集/用户上传页等）。
 * @returns {Promise<{multi: boolean, entries: Array<{index:number,id:string,title:string,duration:number|null}>}>}
 */
export async function inspectUrl(url, { proxy } = {}) {
  const cfg = loadConfig();
  const px = proxy !== undefined ? proxy : cfg.proxy;
  const args = [
    url,
    '--flat-playlist',
    '--dump-single-json',
    '--encoding', 'utf-8',
    '--socket-timeout', '15',
  ];
  if (px) args.push('--proxy', px);
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
    let out = '';
    let err = '';
    const timer = setTimeout(() => killTree(child), 60000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => (out += c));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => (err += c));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.split('\n').filter(Boolean).slice(-3).join('\n') || `yt-dlp 退出码 ${code}`));
      try {
        const j = JSON.parse(out);
        if (j._type === 'playlist' && Array.isArray(j.entries) && j.entries.length > 1) {
          resolve({
            multi: true,
            entries: j.entries.map((e, i) => ({
              index: i + 1,
              id: e?.id ?? String(i + 1),
              title: e?.title ?? `#${i + 1}`,
              duration: e?.duration ?? null,
            })),
          });
        } else {
          resolve({ multi: false, entries: [] });
        }
      } catch (e) {
        reject(new Error('解析 yt-dlp 输出失败: ' + e.message));
      }
    });
  });
}

/**
 * 下载单个 URL（可以是视频、Shorts 或播放列表）。按站点配置分发自定义引擎或 yt-dlp。
 * @returns {Promise<{url: string, files: string[]}>} files 为最终落盘的文件绝对路径
 */
export async function download(url, opts = {}) {
  const site = matchSite(url);
  if (site?.engine === 'douyin') {
    // 抖音为国内直连，不走代理（海外出口反而触发风控）
    return downloadDouyin(url, { ...opts, outDir: opts.outDir ?? DEFAULT_OUT_DIR });
  }
  if (site?.engine === 'xiaohongshu') {
    // 小红书同为国内站，不走代理
    return downloadXiaohongshu(url, { ...opts, outDir: opts.outDir ?? DEFAULT_OUT_DIR });
  }
  if (site?.engine === 'missav') {
    // Cloudflare+HLS 站点：不走代理（走无头浏览器）
    return downloadMissav(url, { ...opts, outDir: opts.outDir ?? DEFAULT_OUT_DIR });
  }
  // 代理 / B站登录态：调用方显式传入 > config.json
  const cfg = loadConfig();
  const proxy = opts.proxy !== undefined ? opts.proxy : cfg.proxy;
  const bilibiliSessdata = opts.bilibiliSessdata !== undefined ? opts.bilibiliSessdata : cfg.bilibiliSessdata;
  return downloadViaYtDlp(url, { ...opts, proxy, bilibiliSessdata });
}

async function downloadViaYtDlp(url, opts = {}) {
  const { onEvent, signal } = opts;
  if (!existsSync(YTDLP)) throw new Error(`未找到 ${YTDLP}\n先运行: npm run setup`);
  if (!existsSync(FFMPEG)) throw new Error(`未找到 ${FFMPEG}\n先运行: npm run setup`);
  const outDir = path.resolve(opts.outDir ?? DEFAULT_OUT_DIR);
  mkdirSync(outDir, { recursive: true });

  // 每个任务先下到自己的临时子目录里，下完再把文件挪进目标目录。
  // 同时下几个任务时，yt-dlp 给重名文件编号的过程互相看不见：直接写进同一个目录的话，
  // 两个进程会抢同一个文件名（.part 被另一个进程改名拿走 → “Unable to rename file”）。
  // 临时目录按任务 id 命名：暂停后 .part 留在里面，恢复 / 重试时还能接着下。
  const workDir = path.join(outDir, `.vd-tmp-${opts.taskId ?? randomUUID().slice(0, 8)}`);
  mkdirSync(workDir, { recursive: true });

  const args = buildArgs(url, { ...opts, outDir: workDir });
  const MAX_RUNS = 10; // 一共最多跑这么多次 yt-dlp
  const MAX_STALLED = 3; // 连续这么多次一点进展都没有就放弃：再试也是白等

  for (let run = 1, stalled = 0; ; run++) {
    if (signal?.aborted) throw abortError();
    const before = partialBytes(workDir);
    const { code, tail, files } = await runYtDlpOnce(url, args, onEvent, signal, { proxy: opts.proxy });
    if (signal?.aborted) throw abortError();
    if (code === 0) {
      const finalFiles = files.map((f) => moveInto(f, outDir));
      for (const f of finalFiles) onEvent?.({ type: 'file', file: f });
      await ensurePlayableFiles(finalFiles, (ev) => onEvent?.(ev));
      rmSync(workDir, { recursive: true, force: true });
      return { url, files: finalFiles };
    }
    // 403/超时/连接类错误多为瞬时问题（常见于代理出口 IP 在解析与下载间变化）；分段地址过期也是
    //（见 buildArgs 里的 --abort-on-unavailable-fragments）。yt-dlp 视 403 为致命错误不重试，这里整层重跑：
    // 临时目录没变，它从没下完的那一段接着下，前面下好的不重下
    const text = tail.join('\n');
    const progressed = partialBytes(workDir) > before; // 这一趟有没有往下走
    stalled = progressed ? 0 : stalled + 1;
    if (!TRANSIENT_ERR_RE.test(text) || run >= MAX_RUNS || stalled >= MAX_STALLED) throw new Error(failureMessage(code, tail, opts.proxy));
    const status = /HTTP Error (\d{3})/.exec(text)?.[1];
    onEvent?.({
      type: 'info',
      raw: `[retry] 下载中断（${status ? `HTTP ${status}` : '网络瞬时错误'}），${progressed ? '从断点' : '重新'}重试（第 ${run} 次）…`,
    });
    await new Promise((r) => setTimeout(r, 1500 * stalled));
  }
}

/** 临时目录里没下完的部分一共多少字节（.part / .ytdl / 分段下载的 .part-Frag…）。用来判断重跑有没有往前走 */
function partialBytes(dir) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.includes('.part') || e.name.endsWith('.ytdl')) {
        try {
          total += statSync(p).size;
        } catch {}
      }
    }
  };
  walk(dir);
  return total;
}

/** yt-dlp 失败时给用户看的报错：它的原始报错，加上能确定的提示 */
function failureMessage(code, tail, proxy) {
  let message = `yt-dlp 退出码 ${code}\n${tail.join('\n')}`;
  if (!proxy && UNREACHABLE_ERR_RE.test(tail.join('\n'))) {
    message += '\n提示：连不上这个站点（连接超时或被中断）。它可能在当前网络下无法直接访问 —— 在 ⚙ 设置里填好代理后再试。';
  }
  return message;
}

/** 把 [file] 挪进 [dir]；已经有同名文件时依次用「名字 (1)」「名字 (2)」……（不覆盖已有的文件） */
function moveInto(file, dir) {
  const base = path.basename(file);
  let target = path.join(dir, base);
  if (existsSync(target)) {
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    for (let n = 1; ; n++) {
      target = path.join(dir, `${stem} (${n})${ext}`);
      if (!existsSync(target)) break;
    }
  }
  renameSync(file, target);
  return target;
}

function abortError() {
  const e = new Error('已中止');
  e.name = 'AbortError';
  return e;
}

/** 跑一次 yt-dlp 进程，收集结果（不抛业务异常）；signal 触发时击杀进程树 */
function runYtDlpOnce(url, args, onEvent, signal, { proxy } = {}) {
  return new Promise((resolve, reject) => {
    // bin/ 放进 PATH 让 yt-dlp 自动发现 deno(JS runtime，解 YouTube 签名挑战)；
    // 同时强制 Python 侧输出编码，双保险避免中文/emoji 被 GBK 破坏
    const child = spawn(YTDLP, args, {
      windowsHide: true,
      env: {
        ...process.env,
        PATH: `${BIN_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
    });
    const onAbort = () => killTree(child);
    if (signal) {
      if (signal.aborted) killTree(child);
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const files = [];
    const tail = []; // 保留末尾若干行，出错时报告
    let stdoutBuf = '';
    // 视频流地址：yt-dlp 在下载前打印，一组收齐就发给界面（不等它，下载照常进行）
    const feedSource = createSourceCollector();

    const emit = (ev) => onEvent?.(ev);

    const handleLine = (line) => {
      const text = line.trim();
      if (!text) return;
      const streams = feedSource(text);
      if (streams !== undefined) {
        if (streams) emitSource(onEvent, streams, { proxy });
        return;
      }
      tail.push(text);
      if (tail.length > 15) tail.shift();

      const m = text.match(PROGRESS_RE);
      if (m) {
        const d = parseProgressDetail(text);
        emit({
          type: 'progress',
          percent: parseFloat(m[1]),
          raw: text,
          ...(d ?? {}),
        });
        return;
      }
      if (text.startsWith('[Merger]')) {
        emit({ type: 'merging', raw: text });
        return;
      }
      // --print 输出的最终路径（不带 [tag] 前缀），用 existsSync 确认。
      // 文件此时还在任务的临时目录里：等挪进目标目录之后再对外公布最终路径
      if (!text.startsWith('[') && existsSync(text)) {
        files.push(text);
        return;
      }
      // 标题标记行
      if (text.startsWith('__TITLE__')) {
        emit({ type: 'title', title: text.slice(9) });
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop();
      for (const l of lines) handleLine(l);
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      for (const l of chunk.split(/\r?\n/)) {
        const text = l.trim();
        if (!text) continue;
        tail.push(text);
        if (tail.length > 15) tail.shift();
        emit({ type: 'log', raw: text });
      }
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (stdoutBuf) handleLine(stdoutBuf);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, tail, files });
    });
  });
}
