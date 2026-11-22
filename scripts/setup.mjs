#!/usr/bin/env node
// 下载 yt-dlp.exe 与 ffmpeg.exe 到 bin/（已存在则跳过，--force 强制重新下载）
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin');
const force = process.argv.includes('--force');

mkdirSync(BIN, { recursive: true });

function downloadTo(url, file, label) {
  console.log(`下载 ${label} ...`);
  const r = spawnSync('curl', ['-L', '--fail', '--retry', '3', '-o', file, url], {
    stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error(`${label} 下载失败（curl 退出码 ${r.status}）`);
}

// 1) yt-dlp 独立版（无需 Python）
const ytdlp = path.join(BIN, 'yt-dlp.exe');
if (!existsSync(ytdlp) || force) {
  downloadTo('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe', ytdlp, 'yt-dlp.exe');
} else {
  console.log('yt-dlp.exe 已存在，跳过');
}

// 2) ffmpeg（BtbN 构建，从 zip 中只提取 ffmpeg.exe）
const ffmpeg = path.join(BIN, 'ffmpeg.exe');
if (!existsSync(ffmpeg) || force) {
  const tmp = path.join(ROOT, '.tmp', 'ffmpeg-zip');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const zip = path.join(tmp, 'ffmpeg.zip');
  downloadTo(
    'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip',
    zip,
    'ffmpeg（约 200MB）',
  );
  console.log('解压 ffmpeg.exe ...');
  // 用 Windows 自带 bsdtar 解压（原生支持 zip；Expand-Archive 在 CI 的 PS 上有参数绑定问题）
  const outDir = path.join(tmp, 'out');
  mkdirSync(outDir, { recursive: true });
  const r = spawnSync('tar', ['-xf', zip, '-C', outDir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('解压失败（tar 退出码 ' + r.status + '）');
  // zip 内层目录名带版本号（随上游构建变化），动态发现而非硬编码
  const inner = readdirSync(outDir).find((d) => existsSync(path.join(outDir, d, 'bin', 'ffmpeg.exe')));
  if (!inner) throw new Error('解压后未找到 bin/ffmpeg.exe');
  renameSync(path.join(outDir, inner, 'bin', 'ffmpeg.exe'), ffmpeg);
  rmSync(tmp, { recursive: true, force: true });
} else {
  console.log('ffmpeg.exe 已存在，跳过');
}

// 3) deno（yt-dlp 的 JS runtime，用于解 YouTube 签名挑战）
const deno = path.join(BIN, 'deno.exe');
if (!existsSync(deno) || force) {
  const tmp = path.join(ROOT, '.tmp', 'deno-zip');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const zip = path.join(tmp, 'deno.zip');
  downloadTo('https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip', zip, 'deno');
  renameSync(zip, deno);
  rmSync(tmp, { recursive: true, force: true });
} else {
  console.log('deno.exe 已存在，跳过');
}

console.log('完成: bin/ 下 yt-dlp.exe、ffmpeg.exe、deno.exe 就绪');
