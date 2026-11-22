// 核心下载器：封装 yt-dlp 进程，解析进度并返回最终文件路径
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchSite } from './sites.mjs';
import { downloadDouyin } from './douyin.mjs';
import { downloadXiaohongshu } from './xiaohongshu.mjs';
import { loadConfig } from './config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
// 打包版（Electron）通过环境变量指向 resources/bin 与系统下载目录
const BIN_DIR = process.env.VD_BIN_DIR || path.join(ROOT, 'bin');
const YTDLP = path.join(BIN_DIR, 'yt-dlp.exe');
const FFMPEG = path.join(BIN_DIR, 'ffmpeg.exe');
export const DEFAULT_OUT_DIR = process.env.VD_OUT_DIR || path.join(ROOT, 'downloads');

const OUTPUT_TEMPLATE = '%(title)s [%(id)s].%(ext)s';

const PROGRESS_RE = /^\[download\]\s+(\d+(?:\.\d+)?)%/;

/** 瞬时网络错误（可整层重试）：403/429/超时/连接中断等 */
const TRANSIENT_ERR_RE =
  /HTTP Error (40[33]|42[99])|unable to download video data|timed?[- ]?out|connection (reset|refused|aborted|timed out)|Unable to connect to proxy|temporary failure|ECONNRESET|EPIPE|IncompleteRead/i;

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
  const { outDir = DEFAULT_OUT_DIR, quality, audioOnly, proxy, bilibiliSessdata, extraArgs = [] } = opts;
  const site = matchSite(url);

  const args = [
    url,
    '--newline',
    '--progress',
    '--print', 'before_dl:__TITLE__%(title)s', // 下载前输出标题（带标记前缀）
    '--print', 'after_move:%(filepath)s', // 下载完成后输出最终文件路径
    '--no-simulate',
    '--encoding', 'utf-8', // 输出用 UTF-8，避免中文/emoji 路径被 GBK 破坏
    '-o', path.join(outDir, OUTPUT_TEMPLATE),
    '--ffmpeg-location', FFMPEG,
    '--retries', '10',
    '--fragment-retries', '10',
    '--extractor-retries', '3',
  ];

  if (proxy) args.push('--proxy', proxy); // http/socks 均支持

  // B 站登录态（解锁 720p+）：SESSDATA 来自浏览器 Cookie，手动复制一次即可
  if (site?.id === 'bilibili' && bilibiliSessdata) {
    args.push('--add-headers', `Cookie: SESSDATA=${bilibiliSessdata}`);
  }

  if (audioOnly) {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else {
    let fmt = site?.format;
    if (quality) {
      fmt = `bv*[height<=${quality}][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[height<=${quality}]+ba/b`;
    }
    args.push('-f', fmt ?? 'bv*+ba/b');
    if (site?.mergeFormat) args.push('--merge-output-format', site.mergeFormat);
  }

  args.push(...extraArgs);
  return args;
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
  // 代理 / B站登录态：调用方显式传入 > config.json
  const cfg = loadConfig();
  const proxy = opts.proxy !== undefined ? opts.proxy : cfg.proxy;
  const bilibiliSessdata = opts.bilibiliSessdata !== undefined ? opts.bilibiliSessdata : cfg.bilibiliSessdata;
  return downloadViaYtDlp(url, { ...opts, proxy, bilibiliSessdata });
}

async function downloadViaYtDlp(url, opts = {}) {
  const { onEvent } = opts;
  if (!existsSync(YTDLP)) throw new Error(`未找到 ${YTDLP}\n先运行: npm run setup`);
  if (!existsSync(FFMPEG)) throw new Error(`未找到 ${FFMPEG}\n先运行: npm run setup`);
  mkdirSync(opts.outDir ?? DEFAULT_OUT_DIR, { recursive: true });

  const args = buildArgs(url, opts);
  const maxAttempts = 3;

  for (let attempt = 1; ; attempt++) {
    const { code, tail, files } = await runYtDlpOnce(url, args, onEvent);
    if (code === 0) {
      await ensurePlayableFiles(files, (ev) => onEvent?.(ev));
      return { url, files };
    }
    // 403/超时/连接类错误多为瞬时问题（常见于代理出口 IP 在解析与下载间变化），
    // yt-dlp 视 403 为致命错误不重试，这里整层重跑
    const transient = TRANSIENT_ERR_RE.test(tail.join('\n'));
    if (transient && attempt < maxAttempts) {
      onEvent?.({ type: 'info', raw: `[retry] 下载中断（第 ${attempt} 次失败，网络瞬时错误），自动重试 ${attempt + 1}/${maxAttempts} …` });
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    throw new Error(`yt-dlp 退出码 ${code}\n${tail.join('\n')}`);
  }
}

/** 跑一次 yt-dlp 进程，收集结果（不抛业务异常） */
function runYtDlpOnce(url, args, onEvent) {
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
    const files = [];
    const tail = []; // 保留末尾若干行，出错时报告
    let stdoutBuf = '';

    const emit = (ev) => onEvent?.(ev);

    const handleLine = (line) => {
      const text = line.trim();
      if (!text) return;
      tail.push(text);
      if (tail.length > 15) tail.shift();

      const m = text.match(PROGRESS_RE);
      if (m) {
        emit({ type: 'progress', percent: parseFloat(m[1]), raw: text });
        return;
      }
      if (text.startsWith('[Merger]')) {
        emit({ type: 'merging', raw: text });
        return;
      }
      // --print 输出的最终路径（不带 [tag] 前缀），用 existsSync 确认
      if (!text.startsWith('[') && existsSync(text)) {
        files.push(text);
        emit({ type: 'file', file: text });
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
      resolve({ code, tail, files });
    });
  });
}
