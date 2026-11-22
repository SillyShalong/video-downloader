#!/usr/bin/env node
// 下载运行时二进制到 bin/（跨平台：Windows / macOS / Linux，x64 / arm64）
//   yt-dlp  — yt-dlp 官方 release（win: yt-dlp.exe / mac: yt-dlp_macos 通用二进制 / linux: yt-dlp[_linux_aarch64]）
//   ffmpeg  — Windows 用 yt-dlp/FFmpeg-Builds zip（功能全，已验证）；mac/linux 用 ffmpeg-static 单文件（免解压）
//   deno    — denoland 官方 zip（mac/linux 解压后含 deno 可执行文件）
// 已存在则跳过，--force 强制重新下载。
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin');
const force = process.argv.includes('--force');

const IS_WIN = process.platform === 'win32';
// Windows 下显式用系统 bsdtar（支持 zip）；Git Bash 的 GNU tar 不支持 zip，会与 CI 行为不一致
const TAR = IS_WIN ? 'C:\\Windows\\System32\\tar.exe' : 'tar';
const IS_MAC = process.platform === 'darwin';

/** 按平台/架构计算下载计划（导出供单元测试校验 URL 与产物名） */
export function planAssets(os = process.platform, arch = process.arch) {
  const win = os === 'win32';
  const mac = os === 'darwin';
  const arm = arch === 'arm64';

  const ytdlpAsset = win ? 'yt-dlp.exe' : mac ? 'yt-dlp_macos' : arm ? 'yt-dlp_linux_aarch64' : 'yt-dlp';
  const denoAsset = win
    ? 'deno-x86_64-pc-windows-msvc.zip'
    : mac
      ? (arm ? 'deno-aarch64-apple-darwin.zip' : 'deno-x86_64-apple-darwin.zip')
      : (arm ? 'deno-aarch64-unknown-linux-gnu.zip' : 'deno-x86_64-unknown-linux-gnu.zip');

  const ytdlp = {
    url: `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ytdlpAsset}`,
    file: win ? 'yt-dlp.exe' : 'yt-dlp',
  };
  const deno = {
    url: `https://github.com/denoland/deno/releases/latest/download/${denoAsset}`,
    file: win ? 'deno.exe' : 'deno',
  };
  const ffmpeg = win
    ? {
        mode: 'zip',
        url: 'https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip',
        file: 'ffmpeg.exe',
      }
    : {
        mode: 'single',
        url: `https://github.com/eugeneware/ffmpeg-static/releases/latest/download/ffmpeg-${mac ? 'darwin' : 'linux'}-${arm ? 'arm64' : 'x64'}`,
        file: 'ffmpeg',
      };
  return { ytdlp, ffmpeg, deno };
}

mkdirSync(BIN, { recursive: true });

function downloadTo(url, file, label) {
  console.log(`下载 ${label} ...`);
  const r = spawnSync('curl', ['-L', '--fail', '--retry', '3', '-o', file, url], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${label} 下载失败（curl 退出码 ${r.status}）`);
}

/** 非 Windows 二进制需要可执行位（zip/tar 解压可能不带） */
function markExecutable(file) {
  if (!IS_WIN) {
    try {
      chmodSync(file, 0o755);
    } catch {}
  }
}

/** 在解压目录里递归（限深度）查找指定文件名 */
function findIn(dir, name, depth = 3) {
  if (depth < 0) return null;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name === name) return p;
      if (e.isDirectory()) {
        const hit = findIn(p, name, depth - 1);
        if (hit) return hit;
      }
    }
  } catch {}
  return null;
}

const { ytdlp, ffmpeg, deno } = planAssets();

// 1) yt-dlp（独立可执行）
const ytdlpDest = path.join(BIN, ytdlp.file);
if (!existsSync(ytdlpDest) || force) {
  downloadTo(ytdlp.url, ytdlpDest, `yt-dlp (${process.platform}/${process.arch})`);
  markExecutable(ytdlpDest);
} else {
  console.log('yt-dlp 已存在，跳过');
}

// 2) ffmpeg（Windows zip 解压；mac/linux 单文件直下）
const ffmpegDest = path.join(BIN, ffmpeg.file);
if (!existsSync(ffmpegDest) || force) {
  if (ffmpeg.mode === 'single') {
    downloadTo(ffmpeg.url, ffmpegDest, `ffmpeg-static (${process.platform}/${process.arch})`);
    markExecutable(ffmpegDest);
  } else {
    const tmp = path.join(ROOT, '.tmp', 'ffmpeg-zip');
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(path.join(tmp, 'out'), { recursive: true });
    const zip = path.join(tmp, 'ffmpeg.zip');
    downloadTo(ffmpeg.url, zip, 'ffmpeg（约 200MB）');
    console.log('解压 ffmpeg ...');
    // 用系统自带 tar 解压（原生支持 zip；Expand-Archive 在 CI 的 PS 上有参数绑定问题）
    const r = spawnSync(TAR, ['-xf', zip, '-C', path.join(tmp, 'out')], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('解压失败（tar 退出码 ' + r.status + '）');
    // zip 内层目录名带版本号（随上游构建变化），动态发现而非硬编码
    const src = findIn(path.join(tmp, 'out'), 'ffmpeg.exe', 3);
    if (!src) throw new Error('解压后未找到 ffmpeg.exe');
    renameSync(src, ffmpegDest);
    rmSync(tmp, { recursive: true, force: true });
  }
} else {
  console.log('ffmpeg 已存在，跳过');
}

// 3) deno（yt-dlp 的 JS runtime，解 YouTube 签名挑战）
const denoDest = path.join(BIN, deno.file);
if (!existsSync(denoDest) || force) {
  const tmp = path.join(ROOT, '.tmp', 'deno-zip');
  rmSync(tmp, { recursive: true, force: true });
  const outDir = path.join(tmp, 'out');
  mkdirSync(outDir, { recursive: true });
  const zip = path.join(tmp, 'deno.zip');
  downloadTo(deno.url, zip, `deno (${process.platform}/${process.arch})`);
  console.log('解压 deno ...');
  const r = spawnSync(TAR, ['-xf', zip, '-C', outDir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('deno 解压失败（tar 退出码 ' + r.status + '）');
  const src = findIn(outDir, deno.file, 2);
  if (!src) throw new Error('deno 解压后未找到可执行文件');
  renameSync(src, denoDest);
  rmSync(tmp, { recursive: true, force: true });
  markExecutable(denoDest);
} else {
  console.log('deno 已存在，跳过');
}

console.log(`完成: bin/ 下 ${ytdlp.file}、${ffmpeg.file}、${deno.file} 就绪（${process.platform}/${process.arch}）`);
