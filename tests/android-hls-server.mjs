// 本地 HLS 测试源（tests/android-e2e.mjs 用）：在电脑上起一个 HTTP 服务，
// 模拟器里通过 http://10.0.2.2:<端口>/ 访问。媒体内容由 ffmpeg 从合成媒体生成：
//   master.m3u8          主播放列表：两档清晰度（高的那档是 AES-128 加密的 TS）
//   ts-aes/index.m3u8    AES-128 加密的 MPEG-TS 分段
//   ts-small/index.m3u8  小清晰度的明文 TS
//   ts-plain/index.m3u8  明文 TS（带 B 帧）
//   fmp4/index.m3u8      fMP4 分段
//   page.html            普通网页：加载后延时请求播放列表（模拟播放器）
//   challenge.html       模拟人机验证：要点一下按钮才会去请求播放列表
// 同时用 ffmpeg 生成每一路的参考文件，用来和 App 下载的结果逐帧比对。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FFMPEG } from './media-tools.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.join(tmpdir(), 'vd-hls-fixtures');
const SRC = path.join(tmpdir(), 'vd-media-fixtures', 'synth.single.mp4');
const HOST = '10.0.2.2'; // 模拟器里指向宿主机
const MIME = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mp4': 'video/mp4',
  '.m4s': 'video/iso.segment',
  '.html': 'text/html; charset=utf-8',
  '.key': 'application/octet-stream',
};

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} 退出码 ${r.status}\n${r.stderr}`);
  return r;
}
const ff = (args) => run(FFMPEG, ['-hide_banner', '-nostdin', '-y', ...args]);
const win = (p) => p.split(path.sep).join('/');

/** 生成测试源（已存在则直接复用）。返回参考文件所在目录 */
export function prepareHlsFixtures() {
  const ref = path.join(ROOT, 'ref');
  if (existsSync(path.join(ref, 'ts-aes.mp4'))) return { root: ROOT, ref };
  if (!existsSync(SRC)) throw new Error(`缺少合成媒体 ${SRC}：先跑一次 node tests/android-media-check.mjs`);
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ref, { recursive: true });
  const dir = (name) => path.join(ROOT, name).replace(/\\/g, '/');

  // AES-128 加密的 TS：key_info 的三行分别是「写进播放列表的 URI / 密钥文件路径 / IV」
  const aes = dir('ts-aes');
  mkdirSync(aes, { recursive: true });
  const key = randomBytes(16);
  writeFileSync(path.join(aes, 'enc.key'), key);
  const keyInfo = path.join(ROOT, 'key_info.txt');
  writeFileSync(keyInfo, `enc.key\n${win(path.join(aes, 'enc.key'))}\n${randomBytes(16).toString('hex')}\n`);
  // 分段文件模板要自己带扩展名（ffmpeg 不会补）
  const hls = (out, extra, ext) =>
    ff(['-i', win(SRC), ...extra, '-hls_time', '2', '-hls_list_size', '0', '-hls_segment_filename', `${out}/seg%03d${ext}`, `${out}/index.m3u8`]);
  hls(aes, ['-c', 'copy', '-hls_key_info_file', win(keyInfo)], '.ts');
  const small = dir('ts-small');
  mkdirSync(small, { recursive: true });
  hls(small, ['-vf', 'scale=320:180', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '64k'], '.ts');
  // 明文 TS：音频特意转成 48kHz 单声道。ffmpeg 在找不到 AAC 配置时会按 44.1kHz 立体声去猜，
  // 用常见格式测不出「配置没写对」这类问题
  const plain = dir('ts-plain');
  mkdirSync(plain, { recursive: true });
  hls(plain, ['-c:v', 'copy', '-c:a', 'aac', '-ac', '1', '-ar', '48000', '-b:a', '96k'], '.ts');
  const fmp4 = dir('fmp4');
  mkdirSync(fmp4, { recursive: true });
  hls(fmp4, ['-c', 'copy', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4'], '.m4s');

  writeFileSync(
    path.join(ROOT, 'master.m3u8'),
    [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.64001f,mp4a.40.2"',
      'ts-aes/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=250000,RESOLUTION=320x180,CODECS="avc1.640015,mp4a.40.2"',
      'ts-small/index.m3u8',
      '',
    ].join('\n'),
  );

  writeFileSync(
    path.join(ROOT, 'page.html'),
    `<!doctype html><html><head><meta charset="utf-8"><title>测试视频页面</title></head><body>
<h1>测试页面</h1>
<script>
  // 模拟播放器：页面加载后稍等一下再去请求播放列表
  setTimeout(function () { fetch('ts-plain/index.m3u8').catch(function () {}); }, 700);
</script></body></html>`,
  );
  writeFileSync(
    path.join(ROOT, 'challenge.html'),
    `<!doctype html><html><head><meta charset="utf-8"><title>Just a moment...</title></head>
<body style="background:#fff;font-family:sans-serif">
<div style="padding:40px"><div style="font-size:22px;margin-bottom:20px">确认您是真人</div>
<button id="verify" style="font-size:22px;padding:16px 32px">I am human</button></div>
<script>
  document.getElementById('verify').addEventListener('click', function () {
    document.title = '验证通过后的视频页';
    fetch('ts-aes/index.m3u8').catch(function () {});
  });
</script></body></html>`,
  );

  // 参考：ffmpeg 自己解密、合并出来的 MP4
  const demux = (playlist) => ['-protocol_whitelist', 'file,crypto,data', '-allowed_extensions', 'ALL', '-i', win(path.join(ROOT, playlist))];
  run(FFMPEG, ['-hide_banner', '-nostdin', '-y', ...demux('ts-aes/index.m3u8'), '-c', 'copy', win(path.join(ref, 'ts-aes.mp4'))]);
  run(FFMPEG, ['-hide_banner', '-nostdin', '-y', ...demux('ts-plain/index.m3u8'), '-c', 'copy', win(path.join(ref, 'ts-plain.mp4'))]);
  run(FFMPEG, ['-hide_banner', '-nostdin', '-y', ...demux('fmp4/index.m3u8'), '-c', 'copy', win(path.join(ref, 'fmp4.mp4'))]);
  return { root: ROOT, ref };
}

/**
 * 启动 HTTP 服务。返回 { port, url(path), requests, close() }
 * @param {object} [opts]
 * @param {string} [opts.root] 测试源目录。默认用 prepareHlsFixtures() 生成的那一套（依赖媒体校验留下的合成媒体）；
 *   只需要 ts-plain/ 这一路的最小测试源可以自己生成后传进来（见 tests/hls-engine.test.mjs）
 */
export async function startHlsServer({ root: customRoot } = {}) {
  const { root, ref } = customRoot ? { root: customRoot, ref: path.join(customRoot, 'ref') } : prepareHlsFixtures();
  /** App 发来的请求：{ method, path, query, headers } —— 用例里检查 Referer / Cookie 是否按预期带上 */
  const requests = [];
  /** 测试可以调慢分段响应（毫秒），好让「下载中途暂停」有足够的时间窗口 */
  const throttle = { delay: 0, prefix: '' };

  // ---- 两个「会出问题」的播放列表（媒体内容都是 ts-plain 那一路）----
  /**
   * 分段地址带有效期：每成功下发 [every] 个分段就换一次 token，之后拿着旧 token 来的请求一律 403，
   * 重新读一遍播放列表才能拿到新 token。用来测「地址过期 → 刷新播放列表接着下」。
   */
  const expiring = { every: 2, token: 1, served: 0, playlistFetches: 0, servedSegments: [], rejected: 0 };
  /** [segment] 这一段在 [broken] 为真时一直回 403。用来测「中途失败 → 修好 → 重试从断点继续」 */
  const flaky = { broken: true, segment: 2, served: [], rejected: 0 };

  /** 把 ts-plain 的播放列表里的分段地址换成 [map] 给出的地址 */
  const remapPlaylist = (map) =>
    readFileSync(path.join(root, 'ts-plain', 'index.m3u8'), 'utf8')
      .split(/\r?\n/)
      .map((line) => (line && !line.startsWith('#') ? map(line) : line))
      .join('\n');
  const sendFile = (res, file, extraHeaders = {}) => {
    const body = readFileSync(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      ...extraHeaders,
    });
    res.end(body);
  };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const pathname = decodeURIComponent(u.pathname);
    requests.push({ method: req.method, path: pathname, query: u.search, headers: req.headers });

    // 分段地址过期
    if (pathname === '/expiring/index.m3u8') {
      expiring.playlistFetches++;
      res.writeHead(200, { 'Content-Type': MIME['.m3u8'], 'Cache-Control': 'no-store' });
      res.end(remapPlaylist((name) => `/expiring/${name}?tok=${expiring.token}`));
      return;
    }
    const exp = /^\/expiring\/(seg\d+\.ts)$/.exec(pathname);
    if (exp) {
      if (u.searchParams.get('tok') !== String(expiring.token)) {
        expiring.rejected++;
        res.writeHead(403, { 'Content-Type': 'text/plain' }).end('token expired');
        return;
      }
      expiring.servedSegments.push(exp[1]);
      if (++expiring.served >= expiring.every) {
        expiring.token++;
        expiring.served = 0;
      }
      sendFile(res, path.join(root, 'ts-plain', exp[1]));
      return;
    }

    // 中途某一段一直 403
    if (pathname === '/flaky/index.m3u8') {
      res.writeHead(200, { 'Content-Type': MIME['.m3u8'], 'Cache-Control': 'no-store' });
      res.end(remapPlaylist((name) => `/flaky/${name}`));
      return;
    }
    const fl = /^\/flaky\/(seg\d+\.ts)$/.exec(pathname);
    if (fl) {
      if (flaky.broken && fl[1] === `seg${String(flaky.segment).padStart(3, '0')}.ts`) {
        flaky.rejected++;
        res.writeHead(403, { 'Content-Type': 'text/plain' }).end('forbidden (simulated)');
        return;
      }
      flaky.served.push(fl[1]);
      sendFile(res, path.join(root, 'ts-plain', fl[1]));
      return;
    }

    const respond = () => {
      const file = path.join(root, path.normalize(pathname));
      if (!file.startsWith(root) || !isFile(file)) {
        res.writeHead(404).end('not found');
        return;
      }
      sendFile(res, file);
    };
    // 请求进来就记一笔（哪怕还没开始响应），用例据此知道 App 已经开始取哪一段
    if (throttle.delay > 0 && pathname.startsWith(throttle.prefix || '/')) setTimeout(respond, throttle.delay);
    else respond();
  });
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
  const port = server.address().port;
  return {
    port,
    ref,
    requests,
    expiring,
    flaky,
    /** 让某个前缀下的请求每条延迟 [ms] 毫秒再响应（prefix 为空 = 全部） */
    slowDown: (ms, prefix = '') => {
      throttle.delay = ms;
      throttle.prefix = prefix;
    },
    url: (p) => `http://${HOST}:${port}/${p}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
