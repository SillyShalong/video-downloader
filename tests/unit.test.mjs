// 单元测试：纯逻辑（站点识别、URL 抽取、参数构建、配置校验、explorer 参数、历史）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { matchSite, extractUrls } from '../src/sites.mjs';
import { buildArgs, parseProgressDetail } from '../src/downloader.mjs';
import { SOURCE_PRINT_ARGS, annotateIps, createSourceCollector, emitSource, streamsFromUrls, summarizeSources } from '../src/stream-source.mjs';
import { isValidProxy } from '../src/config.mjs';
import { buildExplorerArgs } from '../src/server.mjs';

// ---------- yt-dlp 进度行解析（速度/ETA/总量） ----------
test('parseProgressDetail: 常见进度行格式', () => {
  const KiB = 1024;
  const MiB = 1024 ** 2;
  // 常规格式：45.3% of 10.00MiB at 1.50MiB/s ETA 00:05
  let d = parseProgressDetail('[download]  45.3% of   10.00MiB at    1.50MiB/s ETA 00:05');
  assert.equal(d.total, 10 * MiB);
  assert.equal(d.speed, 1.5 * MiB);
  assert.equal(d.eta, 5);
  // 估算大小（~ 前缀）无 ETA
  d = parseProgressDetail('[download]  31.2% of ~ 3.00MiB at 301.85KiB/s');
  assert.equal(d.total, 3 * MiB);
  assert.equal(d.speed, 301.85 * KiB);
  assert.equal(d.eta, null);
  // 完成行：100% of 10.00MiB in 00:00:04 at 1.86MiB/s
  d = parseProgressDetail('[download] 100% of   10.00MiB in 00:00:04 at 1.86MiB/s');
  assert.equal(d.total, 10 * MiB);
  assert.equal(d.speed, 1.86 * MiB);
  // GiB 与分:秒 ETA
  d = parseProgressDetail('[download]  12.5% of ~ 1.50GiB at 2.00MiB/s ETA 12:30');
  assert.equal(d.total, 1.5 * 1024 ** 3);
  assert.equal(d.eta, 750);
  // 无速度信息
  d = parseProgressDetail('[download]  50.0% of  477.56KiB at  Unknown B/s ETA Unknown');
  assert.equal(d.total, 477.56 * KiB);
  assert.equal(d.speed, null);
});

// ---------- 站点识别 ----------
test('matchSite: YouTube 各域名', () => {
  for (const u of [
    'https://www.youtube.com/watch?v=x',
    'https://youtu.be/x',
    'https://m.youtube.com/shorts/x',
    'https://music.youtube.com/watch?v=x',
    'https://www.youtube-nocookie.com/embed/x',
  ]) {
    assert.equal(matchSite(u)?.id, 'youtube', u);
  }
});

test('matchSite: 抖音各域名', () => {
  for (const u of ['https://v.douyin.com/abc/', 'https://www.douyin.com/video/123', 'https://www.iesdouyin.com/x']) {
    assert.equal(matchSite(u)?.id, 'douyin', u);
  }
});

test('matchSite: B站各域名（含 b23.tv 短链）', () => {
  for (const u of [
    'https://www.bilibili.com/video/BV1GJ411x7h7',
    'https://bilibili.com/video/BV1xx411c7mD',
    'https://m.bilibili.com/video/BV1GJ411x7h7',
    'https://b23.tv/xxxxxxx',
  ]) {
    assert.equal(matchSite(u)?.id, 'bilibili', u);
  }
});

test('matchSite: 其他站点为 null（走 yt-dlp 默认）', () => {
  assert.equal(matchSite('https://vimeo.com/123456'), null);
  assert.equal(matchSite('不是链接'), null);
});

// ---------- 分享口令 URL 抽取 ----------
test('extractUrls: 抖音分享口令', () => {
  const text = '0.56 复制打开抖音，看看【xx的作品】... https://v.douyin.com/YS81GPkMQ8M/ 12/28 :4pm hbA:/ m@d.NJ';
  assert.deepEqual(extractUrls(text), ['https://v.douyin.com/YS81GPkMQ8M/']);
});

test('extractUrls: 多条链接与去尾标点', () => {
  const urls = extractUrls('看 https://a.com/x 和 https://b.com/y。完');
  assert.deepEqual(urls, ['https://a.com/x', 'https://b.com/y']);
});

test('extractUrls: 无链接返回空数组', () => {
  assert.deepEqual(extractUrls('纯文本没有链接'), []);
});

// ---------- yt-dlp 参数构建 ----------
test('buildArgs: 基础参数（编码、打印、输出模板、重试）', () => {
  const args = buildArgs('https://youtu.be/x', { outDir: 'D:/out' });
  assert.ok(args.includes('--encoding'));
  assert.ok(args.includes('utf-8'));
  assert.ok(args.some((a, i) => a === '--print' && args[i + 1] === 'after_move:%(filepath)s'));
  assert.ok(args.some((a, i) => a === '--print' && args[i + 1] === 'before_dl:__TITLE__%(title)s'));
  assert.ok(args.includes('--no-simulate'));
  assert.ok(args.join(' ').includes('D:\\out') || args.join(' ').includes('D:/out'));
  assert.ok(args.includes('--extractor-retries'));
});

test('buildArgs: YouTube 默认锁定 avc1（H.264 兼容）', () => {
  const args = buildArgs('https://youtu.be/x', {});
  const i = args.indexOf('-f');
  assert.ok(args[i + 1].includes('vcodec^=avc1'), '必须显式锁定 avc1');
});

test('buildArgs: B站同样锁定 avc1（避开 av01/hev1 兼容坑）', () => {
  const args = buildArgs('https://www.bilibili.com/video/BV1GJ411x7h7', {});
  assert.ok(args[args.indexOf('-f') + 1].includes('vcodec^=avc1'));
});

test('buildArgs: B站 SESSDATA 注入 Cookie；其他站点不注入', () => {
  const args = buildArgs('https://www.bilibili.com/video/BV1GJ411x7h7', { bilibiliSessdata: 'abc%2C123' });
  const i = args.indexOf('--add-headers');
  assert.equal(args[i + 1], 'Cookie: SESSDATA=abc%2C123');
  // YouTube 链接即使传了也不应注入
  const ytArgs = buildArgs('https://youtu.be/x', { bilibiliSessdata: 'abc%2C123' });
  assert.equal(ytArgs.indexOf('--add-headers'), -1);
  // 未提供 SESSDATA 不注入
  assert.equal(buildArgs('https://www.bilibili.com/video/BV1xx', {}).indexOf('--add-headers'), -1);
});

test('buildArgs: 代理透传', () => {
  const args = buildArgs('https://youtu.be/x', { proxy: 'socks5://127.0.0.1:1080' });
  const i = args.indexOf('--proxy');
  assert.equal(args[i + 1], 'socks5://127.0.0.1:1080');
  // 未配置代理时不应有 --proxy
  assert.equal(buildArgs('https://youtu.be/x', {}).indexOf('--proxy'), -1);
});

test('buildArgs: 清晰度限制映射为 height<=N 且保持 avc1 优先', () => {
  const args = buildArgs('https://youtu.be/x', { quality: '720' });
  const fmt = args[args.indexOf('-f') + 1];
  assert.ok(fmt.includes('height<=720'));
  assert.ok(fmt.includes('vcodec^=avc1'));
});

test('buildArgs: 仅音频走 -x mp3', () => {
  const args = buildArgs('https://youtu.be/x', { audioOnly: true });
  assert.ok(args.includes('-x'));
  assert.equal(args[args.indexOf('--audio-format') + 1], 'mp3');
});

test('buildArgs: 多视频源 playlistItems 映射为 --playlist-items', () => {
  const args = buildArgs('https://youtu.be/x', { playlistItems: [1, 3, 5] });
  const i = args.indexOf('--playlist-items');
  assert.equal(args[i + 1], '1,3,5');
  // 空数组/不传不添加
  assert.equal(buildArgs('https://youtu.be/x', {}).indexOf('--playlist-items'), -1);
  assert.equal(buildArgs('https://youtu.be/x', { playlistItems: [] }).indexOf('--playlist-items'), -1);
});

// ---------- 视频流来源（详情里显示的真正下载地址：域名 + 解析出的 IP） ----------
// 下面几组行是 yt-dlp 真实输出的样子（带标记前缀，一个视频一组，最后一行到了才算收齐）
const CDN = 'rr5---sn-a5meknd6.googlevideo.com';
const YT_MERGED = [
  `__SRC_FORMATS__[{"format_id":"137","format_note":"1080p","height":1080,"ext":"mp4","vcodec":"avc1.640028","acodec":"none","protocol":"https","url":"https://${CDN}/videoplayback?expire=1&id=oo"},` +
    `{"format_id":"140","format_note":"audio only","ext":"m4a","vcodec":"none","acodec":"mp4a.40.2","protocol":"https","url":"https://${CDN}/videoplayback?expire=1&id=aa"}]`,
  '__SRC_URL__NA',
  '__SRC_URLS__"https://' + CDN + '/videoplayback?expire=1&id=oo\\nhttps://' + CDN + '/videoplayback?expire=1&id=aa"',
  '__SRC_MANIFEST__NA',
  '__SRC_INFO__137+140|137 - 1920x1080 (1080p)+140 - audio only (medium)|NA|NA|https+https|mp4',
];
const HLS_SINGLE = [
  '__SRC_FORMATS__NA',
  '__SRC_URL__https://cdn.example.com/hls/720p/index.m3u8',
  '__SRC_URLS__["https://cdn.example.com/hls/720p/index.m3u8"]',
  '__SRC_MANIFEST__https://cdn.example.com/hls/master.m3u8',
  '__SRC_INFO__900|900 - 1280x720|avc1.64001f|mp4a.40.2|m3u8_native|mp4',
];

test('stream-source: 合成格式 → 视频、音频各一路，带各自的域名；一组没收齐之前不出结果', () => {
  const feed = createSourceCollector();
  for (const line of YT_MERGED.slice(0, -1)) assert.equal(feed(line), null, '没收到最后一行不算收齐');
  const streams = feed(YT_MERGED[YT_MERGED.length - 1]);
  assert.equal(streams.length, 2);
  assert.deepEqual(streams.map((s) => s.role), ['video', 'audio']);
  assert.deepEqual(streams.map((s) => s.label), ['137 · 1080p · mp4', '140 · m4a']);
  for (const s of streams) {
    assert.equal(s.protocol, 'https');
    assert.equal(s.links.length, 1);
    assert.equal(s.links[0].kind, 'url');
    assert.equal(s.links[0].host, CDN);
    assert.equal(s.links[0].hostname, CDN);
    assert.equal(s.links[0].ips, null, '刚解析出来时 IP 还没解析');
  }
  assert.equal(streams[0].links[0].url, `https://${CDN}/videoplayback?expire=1&id=oo`);
  assert.equal(streams[1].links[0].url, `https://${CDN}/videoplayback?expire=1&id=aa`);
});

test('stream-source: 单一格式（直链文件）与分段流（播放列表地址）', () => {
  const feed = createSourceCollector();
  // 直接给一个文件地址：format_id 就是扩展名，标签里不重复写
  for (const l of ['__SRC_FORMATS__NA', '__SRC_URL__http://127.0.0.1:53329/fake.mp4', '__SRC_URLS__"http://127.0.0.1:53329/fake.mp4"', '__SRC_MANIFEST__NA']) feed(l);
  const [file] = feed('__SRC_INFO__mp4|mp4 - unknown|NA|NA|http|mp4');
  assert.equal(file.role, 'both');
  assert.equal(file.label, 'mp4');
  assert.equal(file.protocol, 'http');
  assert.equal(file.links[0].kind, 'url');
  assert.equal(file.links[0].host, '127.0.0.1:53329', '带端口号');
  assert.equal(file.links[0].ips, null);

  // HLS：地址是这一档的子列表，另有主列表；分段的域名和它们相同，就不再单列
  for (const l of HLS_SINGLE.slice(0, -1)) feed(l);
  const [hls] = feed(HLS_SINGLE[HLS_SINGLE.length - 1]);
  assert.equal(hls.role, 'both');
  assert.equal(hls.protocol, 'm3u8_native');
  assert.deepEqual(hls.links.map((l) => [l.kind, l.url]), [
    ['url', 'https://cdn.example.com/hls/720p/index.m3u8'],
    ['manifest', 'https://cdn.example.com/hls/master.m3u8'],
  ]);
});

test('stream-source: 分段在别的域名上时，每个域名多列一条「分段」', () => {
  const feed = createSourceCollector();
  for (const l of [
    '__SRC_FORMATS__NA',
    '__SRC_URL__NA',
    '__SRC_URLS__["https://cdn.example.com/dash/init.mp4","https://seg1.other-cdn.net/a/seg$Number$.m4s","https://seg1.other-cdn.net/b/seg$Number$.m4s","https://seg2.other-cdn.net/x.m4s"]',
    '__SRC_MANIFEST__https://cdn.example.com/dash/manifest.mpd',
  ]) {
    assert.equal(feed(l), null);
  }
  const [stream] = feed('__SRC_INFO__900|900 - 1280x720|avc1.64001f|mp4a.40.2|http_dash_segments|mp4');
  assert.equal(stream.role, 'both');
  assert.equal(stream.protocol, 'http_dash_segments');
  assert.deepEqual(stream.links.map((l) => [l.kind, l.host]), [
    ['manifest', 'cdn.example.com'],
    // 初始化段和播放列表同域名，不重复列；同一域名下的多个分段模板只记一次
    ['segment', 'seg1.other-cdn.net'],
    ['segment', 'seg2.other-cdn.net'],
  ]);
});

test('stream-source: 不是来源行的原样放过；yt-dlp 的输出损坏时不抛错（不能影响下载）', () => {
  const feed = createSourceCollector();
  assert.equal(feed('[download]  12.3% of   10.00MiB at 1.00MiB/s ETA 00:08'), undefined, '进度行不是来源行');
  assert.equal(feed('__TITLE__某个标题'), undefined);
  for (const l of ['__SRC_FORMATS__[{"format_id": "137", "format', '__SRC_URL__NA', '__SRC_URLS__NA', '__SRC_MANIFEST__NA']) feed(l);
  assert.equal(feed('__SRC_INFO__137|137 - 1080p|avc1|none|https|mp4'), null, 'JSON 被截断：这一组作废');
  // 作废的下一组照常工作
  for (const l of HLS_SINGLE.slice(0, -1)) feed(l);
  assert.equal(feed(HLS_SINGLE[HLS_SINGLE.length - 1]).length, 1);
});

test('stream-source: 引擎自己拿到的直链（抖音 / 小红书）：第一个是地址，其余是备用地址', () => {
  assert.deepEqual(streamsFromUrls([]), []);
  const [stream] = streamsFromUrls(['https://a.example.com/v.mp4', 'https://b.example.com/v.mp4', '', null]);
  assert.equal(stream.role, 'both');
  assert.equal(stream.protocol, 'https');
  assert.deepEqual(stream.links.map((l) => [l.kind, l.host, l.ips]), [
    ['url', 'a.example.com', null],
    ['alternate', 'b.example.com', null],
  ]);
});

test('stream-source: 补上本机解析出的 IP；IP 字面量不用解析；走代理时只解析代理、不显示账号密码', async () => {
  const streams = streamsFromUrls(['http://127.0.0.1:8080/a.mp4', 'https://[::1]:443/b.mp4']);
  const direct = await annotateIps(streams);
  assert.equal(direct.proxy, null);
  assert.deepEqual(direct.streams[0].links.map((l) => l.ips), [['127.0.0.1'], ['::1']]);
  assert.equal(streams[0].links[0].ips, null, '不改传入的对象（先发出去的那份保持「解析中」）');

  const viaProxy = await annotateIps(streams, { proxy: 'http://user:secret@127.0.0.1:7890' });
  assert.equal(viaProxy.proxy.display, 'http://127.0.0.1:7890');
  assert.deepEqual(viaProxy.proxy.ips, ['127.0.0.1']);
  assert.deepEqual(viaProxy.streams[0].links.map((l) => l.ips), [[], []], '视频流的域名由代理那一侧解析，本机不解析');
});

test('stream-source: 先立刻发一次、IP 解析完再发一次，两次是同一个 id；日志一行列出域名和 IP', async () => {
  const events = [];
  emitSource((ev) => events.push(ev), streamsFromUrls(['http://127.0.0.1:9/v.mp4']));
  assert.equal(events.length, 1, '不等解析就先发');
  assert.equal(events[0].type, 'source');
  assert.equal(events[0].streams[0].links[0].ips, null);
  await new Promise((r) => setImmediate(r));
  assert.equal(events.length, 2);
  assert.equal(events[1].sourceId, events[0].sourceId, '接收方据此原地更新，而不是再记一行');
  assert.deepEqual(events[1].streams[0].links[0].ips, ['127.0.0.1']);

  assert.equal(summarizeSources(events[0]), '127.0.0.1:9（解析中…）');
  assert.equal(summarizeSources(events[1]), '127.0.0.1:9 → 127.0.0.1');
  const feed = createSourceCollector();
  let merged;
  for (const l of YT_MERGED) merged = feed(l);
  assert.equal(summarizeSources({ streams: merged, proxy: null }), `${CDN}（解析中…）`, '视频、音频两路在同一个域名上，只列一次');
  assert.equal(summarizeSources({ streams: [], proxy: { display: 'http://127.0.0.1:7890', ips: ['127.0.0.1'] } }), 'http://127.0.0.1:7890 → 127.0.0.1');
});

test('buildArgs: 下载前让 yt-dlp 把选中的格式（视频流地址）打印出来', () => {
  const args = buildArgs('https://youtu.be/x', {});
  for (let i = 0; i < SOURCE_PRINT_ARGS.length; i += 2) {
    const at = args.indexOf(SOURCE_PRINT_ARGS[i + 1]);
    assert.ok(at > 0, SOURCE_PRINT_ARGS[i + 1]);
    assert.equal(args[at - 1], '--print');
  }
});

// ---------- 代理地址校验 ----------
test('isValidProxy: 合法与非法', () => {
  for (const ok of ['', 'http://127.0.0.1:7890', 'https://p.example.com:8080', 'socks5://1.2.3.4:1080', 'socks5h://a:1', 'socks4://a:1']) {
    assert.equal(isValidProxy(ok), true, ok);
  }
  for (const bad of ['127.0.0.1:7890', 'ftp://x', 'http://', 'javascript:alert(1)', 'abc']) {
    assert.equal(isValidProxy(bad), false, bad);
  }
});

// ---------- explorer 参数（回归：含空格路径不能整段加引号） ----------
test('buildExplorerArgs: 文件 → /select,"路径"，引号仅包路径', () => {
  const [arg] = buildExplorerArgs('C:\\dl\\POV： Buying GPU 💀 [id].mp4', false);
  assert.equal(arg, '/select,"C:\\dl\\POV： Buying GPU 💀 [id].mp4"');
  assert.ok(arg.startsWith('/select,"'));
  assert.ok(arg.endsWith('"'));
  // 关键断言：引号内不能再有 /select, 前缀（之前 bug 是整段被包引号）
  assert.ok(!arg.startsWith('"/select'));
});

test('buildExplorerArgs: 目录直接打开；路径中的引号被剥离', () => {
  const [dirArg] = buildExplorerArgs('C:\\my dir', true);
  assert.equal(dirArg, '"C:\\my dir"');
  const [clean] = buildExplorerArgs('C:\\a"b\\c.mp4', false);
  assert.equal(clean, '/select,"C:\\ab\\c.mp4"');
});

// ---------- 跨平台抽象（platform.mjs） ----------
const platform = await import('../src/platform.mjs');

// ---------- HLS 站点归一化（设置面板 + config.json 同步） ----------
const { normalizeHlsSites } = await import('../src/config.mjs');

test('normalizeHlsSites: 去 scheme/www/路径、小写、去重、过滤非法', () => {
  assert.deepEqual(
    normalizeHlsSites(['https://www.Example.com/watch/1', 'MISSAV.ws', 'https://missav.ws', 'not a domain', '', 'missav.ws']),
    ['example.com', 'missav.ws'],
  );
  assert.deepEqual(
    normalizeHlsSites('a.org,,b.org;\nhttps://c.org/path?q=1'),
    ['a.org', 'b.org', 'c.org'],
  );
  assert.deepEqual(normalizeHlsSites([]), []);
  assert.deepEqual(normalizeHlsSites('垃圾输入'), []);
});

test('platform: revealCommand 三平台命令形态', () => {
  // Windows：explorer + verbatim（引号仅包路径的回归约束）
  const w = platform.revealCommand('C:\\a b\\v.mp4', false, 'win32');
  assert.equal(w.file, 'explorer.exe');
  assert.deepEqual(w.args, ['/select,"C:\\a b\\v.mp4"']);
  assert.equal(w.verbatim, true);
  // macOS：open -R 在 Finder 定位
  const m = platform.revealCommand('/Users/x/v.mp4', false, 'darwin');
  assert.deepEqual([m.file, m.args], ['open', ['-R', '/Users/x/v.mp4']]);
  assert.equal(m.verbatim, false);
  // Linux：xdg-open 打开所在目录
  const l = platform.revealCommand('/home/x/v.mp4', false, 'linux');
  assert.equal(l.file, 'xdg-open');
  assert.deepEqual(l.args, ['/home/x']);
});

test('platform: openCommand 三平台命令形态', () => {
  const w = platform.openCommand('C:\\a b.mp4', 'win32');
  assert.deepEqual([w.file, w.args], ['cmd', ['/c', 'start', '', 'C:\\a b.mp4']]);
  const m = platform.openCommand('/Users/x/a.mp4', 'darwin');
  assert.deepEqual([m.file, m.args], ['open', ['/Users/x/a.mp4']]);
  const l = platform.openCommand('/home/x/a.mp4', 'linux');
  assert.deepEqual([l.file, l.args], ['xdg-open', ['/home/x/a.mp4']]);
});

test('platform: 二进制名按平台解析', () => {
  assert.equal(platform.ytDlpName('win32'), 'yt-dlp.exe');
  assert.equal(platform.ytDlpName('darwin'), 'yt-dlp');
  assert.equal(platform.ytDlpName('linux'), 'yt-dlp');
  assert.equal(platform.ffmpegName('win32'), 'ffmpeg.exe');
  assert.equal(platform.ffmpegName('linux'), 'ffmpeg');
  assert.equal(platform.denoName('win32'), 'deno.exe');
  assert.equal(platform.denoName('darwin'), 'deno');
});

// ---------- setup.mjs 下载计划（多平台资产 URL） ----------
const { planAssets } = await import('../scripts/setup.mjs');

test('planAssets: 五种 OS/arch 组合的下载计划', () => {
  const win = planAssets('win32', 'x64');
  assert.ok(win.ytdlp.url.endsWith('/yt-dlp.exe'));
  assert.ok(win.deno.url.endsWith('/deno-x86_64-pc-windows-msvc.zip'));
  assert.equal(win.ffmpeg.mode, 'zip'); // Windows 走 FFmpeg-Builds 全功能包
  assert.equal(win.ytdlp.file, 'yt-dlp.exe');

  const macArm = planAssets('darwin', 'arm64');
  assert.ok(macArm.ytdlp.url.endsWith('/yt-dlp_macos')); // 通用二进制
  assert.ok(macArm.deno.url.endsWith('/deno-aarch64-apple-darwin.zip'));
  assert.equal(macArm.ffmpeg.mode, 'single');
  assert.ok(macArm.ffmpeg.url.endsWith('/ffmpeg-darwin-arm64'));

  const macX64 = planAssets('darwin', 'x64');
  assert.ok(macX64.ffmpeg.url.endsWith('/ffmpeg-darwin-x64'));
  assert.ok(macX64.deno.url.endsWith('/deno-x86_64-apple-darwin.zip'));

  const linX64 = planAssets('linux', 'x64');
  assert.ok(linX64.ytdlp.url.endsWith('/yt-dlp'));
  assert.ok(linX64.ffmpeg.url.endsWith('/ffmpeg-linux-x64'));
  assert.ok(linX64.deno.url.endsWith('/deno-x86_64-unknown-linux-gnu.zip'));

  const linArm = planAssets('linux', 'arm64');
  assert.ok(linArm.ytdlp.url.endsWith('/yt-dlp_linux_aarch64'));
  assert.ok(linArm.ffmpeg.url.endsWith('/ffmpeg-linux-arm64'));
  assert.ok(linArm.deno.url.endsWith('/deno-aarch64-unknown-linux-gnu.zip'));

  // 非 Windows 产物名无 .exe（与 platform.mjs 命名一致）
  for (const p of [macArm, linX64]) {
    assert.equal(p.ytdlp.file, 'yt-dlp');
    assert.equal(p.ffmpeg.file, 'ffmpeg');
    assert.equal(p.deno.file, 'deno');
  }
});

// ---------- 下载历史 ----------
test('history: 保存/读取往返、同 id 去重、上限裁剪', async () => {
  const { loadHistory, appendHistory } = await import('../src/history.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'vd-hist-')), 'history.json');
  try {
    assert.deepEqual(loadHistory(file), [], '初始为空');
    appendHistory({ id: 'a', url: 'https://x/1', file: 'D:/v/a.mp4', title: 'A' }, file);
    appendHistory({ id: 'b', url: 'https://x/2', file: 'D:/v/b.mp4', title: 'B' }, file);
    appendHistory({ id: 'a', url: 'https://x/1', file: 'D:/v/a2.mp4', title: 'A2' }, file); // 覆盖同 id
    let list = loadHistory(file);
    assert.equal(list.length, 2, '同 id 去重后 2 条');
    assert.equal(list.find((r) => r.id === 'a').file, 'D:/v/a2.mp4', '保留最新');
    // 上限裁剪（大量追加后只留最近的）
    for (let i = 0; i < 600; i++) appendHistory({ id: 'n' + i, url: 'u' + i }, file);
    list = loadHistory(file);
    assert.equal(list.length, 500, '上限 500');
    assert.ok(list.some((r) => r.id === 'n599'), '保留最新记录');
  } finally {
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
});
