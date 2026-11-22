#!/usr/bin/env node
// 用法: node cli.mjs <视频URL...> [-o 输出目录] [-q 最大分辨率如1080] [--audio]
import { parseArgs } from 'node:util';
import path from 'node:path';
import { download, DEFAULT_OUT_DIR, ROOT } from './src/downloader.mjs';
import { extractUrls } from './src/sites.mjs';

const HELP = `video-downloader — 基于 yt-dlp 的视频下载工具

用法:
  node cli.mjs <视频URL...> [选项]

选项:
  -o, --out <目录>    输出目录（默认 downloads/）
  -q, --quality <高度> 限制最大分辨率，如 720、1080
  -p, --proxy <地址>  HTTP/SOCKS 代理，如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080
                      （仅 YouTube 等 yt-dlp 站点生效；不传则用 config.json 里的配置）
      --audio         只下载音频，转成 mp3
  -h, --help          显示帮助

示例:
  node cli.mjs "https://www.youtube.com/watch?v=xxxx"
  node cli.mjs "https://youtu.be/xxxx" -q 1080 --audio
  node cli.mjs "https://youtu.be/xxxx" -p http://127.0.0.1:7890`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', short: 'o', default: DEFAULT_OUT_DIR },
    quality: { type: 'string', short: 'q' },
    proxy: { type: 'string', short: 'p' },
    audio: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help || positionals.length === 0) {
  console.log(HELP);
  process.exit(values.help ? 0 : 1);
}

if (values.quality && !/^\d{3,4}$/.test(values.quality)) {
  console.error(`无效的分辨率: ${values.quality}（应为 360 / 720 / 1080 等）`);
  process.exit(1);
}

if (values.proxy && !/^(https?|socks[45]a?h?):\/\/[^\s]+$/.test(values.proxy)) {
  console.error(`无效的代理地址: ${values.proxy}（应形如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080）`);
  process.exit(1);
}

const urls = [...new Set(positionals.flatMap((p) => (p.startsWith('http') ? [p] : extractUrls(p))))];
if (urls.length === 0) {
  console.error(`参数中未发现 URL: ${positionals.join(' ')}`);
  process.exit(1);
}

const outDir = path.resolve(values.out);
const tty = process.stdout.isTTY;

function onEvent(ev) {
  if (ev.type === 'progress') {
    if (tty) {
      process.stdout.write('\r' + ev.raw.slice(0, 110).padEnd(110));
    } else {
      console.log(ev.raw);
    }
  } else if (ev.type === 'merging') {
    if (tty) process.stdout.write('\r\x1b[K');
    console.log('  合并音视频流 ...');
  } else if (ev.type === 'info') {
    if (tty) process.stdout.write('\r\x1b[K');
    console.log(`  ${ev.raw}`);
  } else if (ev.type === 'title') {
    if (tty) process.stdout.write('\r\x1b[K');
    console.log(`  《${ev.title}》`);
  } else if (ev.type === 'file') {
    if (tty) process.stdout.write('\r\x1b[K');
    console.log(`✔ ${ev.file}`);
  } else if (ev.type === 'log' && ev.raw.startsWith('ERROR')) {
    if (tty) process.stdout.write('\n');
    console.error(ev.raw);
  }
}

let failed = 0;
for (const url of urls) {
  console.log(`▶ 下载: ${url}`);
  console.log(`  输出目录: ${outDir}`);
  try {
    const { files } = await download(url, {
      outDir,
      quality: values.quality,
      proxy: values.proxy || undefined, // 不传则使用 config.json 的全局配置
      audioOnly: values.audio,
      onEvent,
    });
    if (files.length === 0) console.log('  （未产生新文件，可能已存在或被跳过）');
  } catch (err) {
    failed++;
    console.error(`✖ 失败: ${url}\n${err.message}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
