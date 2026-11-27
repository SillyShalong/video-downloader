// 桌面端 HLS 引擎（src/missav.mjs）的下载部分：分段地址过期之后要接着下，不能留下半截文件。
//
// 用本地 HTTP 服务模拟「分段地址带有效期」（tests/android-hls-server.mjs）：每成功下发 N 段就换一次 token，
// 之后拿旧 token 来的请求一律 403。测试源是 ffmpeg 现场生成的一段 8 秒视频（4 段，每段 2 秒），
// 不依赖安卓媒体校验留下的合成媒体。
//
// 用户报过的现象：HLS 下到一半服务端回 403，重试时从头开始下。排查时还发现更糟的一层 ——
// yt-dlp 的原生 HLS 下载器默认把拿不到的分段当「不存在」跳过，后面的分段（用的是同一个过期的 token）
// 也全跳过，最后以成功退出：任务显示「完成」，文件却只有前半截。所以这里的「正确」不只是下完，
// 还包括结果必须和不出错时下载的逐字节相同。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadHlsStream, downloadMissav, hlsBinaries, hlsResumePoint } from '../src/missav.mjs';
import { findEdge } from '../src/headless-edge.mjs';
import { ffmpegName, ytDlpName } from '../src/platform.mjs';
import { startHlsServer } from './android-hls-server.mjs';
import { FFMPEG, assertPlayable, assertSameAudio, assertSameVideo } from './media-tools.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT = 120000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const win = (p) => p.split(path.sep).join('/');

/** 轮询直到 fn() 返回真 */
async function until(what, fn, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error(`等了很久还没出现：${what}`);
}

// ---- 测试源：www/ts-plain/{index.m3u8, seg000..003.ts} + www/page.html（一个会去请求播放列表的网页） ----
const fixture = mkdtempSync(path.join(tmpdir(), 'vd-hls-engine-'));
const www = path.join(fixture, 'www');
const segDir = path.join(www, 'ts-plain');
mkdirSync(segDir, { recursive: true });
// 通用下载路径（src/downloader.mjs）会读 config.json 里的代理设置：必须在导入它之前，把配置指到一份「不走代理」的临时文件上
process.env.VD_CONFIG_PATH = path.join(fixture, 'config.json');
writeFileSync(process.env.VD_CONFIG_PATH, JSON.stringify({ proxy: '' }));
const { download } = await import('../src/downloader.mjs');
const ff = (args) => {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-y', ...args], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg 生成测试源失败:\n${r.stderr.slice(-800)}`);
};
ff([
  '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-t', '8',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '30',
  '-c:a', 'aac', '-ac', '2', '-b:a', '96k',
  '-hls_time', '2', '-hls_list_size', '0',
  '-hls_segment_filename', `${win(segDir)}/seg%03d.ts`,
  `${win(segDir)}/index.m3u8`,
]);
const SEGMENTS = ['seg000.ts', 'seg001.ts', 'seg002.ts', 'seg003.ts'];
writeFileSync(
  path.join(www, 'page.html'),
  `<!doctype html><html><head><meta charset="utf-8"><title>测试视频 - 某站点</title></head><body><video controls></video>
// 模拟播放器：页面加载后去读一遍播放列表（要把内容读完，Chromium 才会把它记进页面的网络记录，引擎是从那里找地址的）
<script>setTimeout(() => fetch('/expiring/index.m3u8').then((r) => r.text()).catch(() => {}), 200);</script></body></html>`,
);

const hls = await startHlsServer({ root: www });
const at = (p) => `http://127.0.0.1:${hls.port}${p}`;
const PLAIN = at('/ts-plain/index.m3u8'); // 分段地址永不过期
const EXPIRING = at('/expiring/index.m3u8'); // 分段地址带 token，会过期
const FLAKY = at('/flaky/index.m3u8'); // 其中某一段一直 403
const PAGE = at('/page.html');

after(() => {
  hls.close();
  rmSync(fixture, { recursive: true, force: true });
});

/** 不出错时下载的结果：后面每个用例都要求和它逐字节相同 */
async function downloadReference(name) {
  const outDir = path.join(fixture, name);
  mkdirSync(outDir, { recursive: true });
  const { files } = await downloadHlsStream(() => PLAIN, { outDir, title: 'ref' });
  return { file: files[0], outDir };
}

test('hlsResumePoint：没在下载 / 有断点 / 断点文件损坏', () => {
  const dir = path.join(fixture, 'resume-point');
  mkdirSync(dir, { recursive: true });
  assert.equal(hlsResumePoint(dir, 'v'), null, '什么都没有时没有断点');
  writeFileSync(path.join(dir, 'v.mp4.ytdl'), JSON.stringify({ downloader: { current_fragment: { index: 3 }, extra_state: {} } }));
  writeFileSync(path.join(dir, 'v.mp4.part'), Buffer.alloc(1234));
  assert.deepEqual(hlsResumePoint(dir, 'v'), { index: 3, bytes: 1234 }, '下到了第 3 段（从 0 起），已有 1234 字节');
  assert.equal(hlsResumePoint(dir, 'other'), null, '只认这个名字的断点');
  writeFileSync(path.join(dir, 'v.mp4.ytdl'), '{ 坏掉的');
  assert.equal(hlsResumePoint(dir, 'v'), null, '断点文件坏了就当没有（从头来，总比读出个错的强）');
  assert.equal(hlsResumePoint(path.join(fixture, '不存在'), 'v'), null, '目录不存在');
});

test('hlsBinaries：打包版的工具在 VD_BIN_DIR 指的目录里，从源码运行时在项目的 bin/', () => {
  const saved = process.env.VD_BIN_DIR;
  try {
    delete process.env.VD_BIN_DIR;
    assert.deepEqual(hlsBinaries(), {
      ytdlp: path.join(REPO, 'bin', ytDlpName()),
      ffmpeg: path.join(REPO, 'bin', ffmpegName()),
    });
    process.env.VD_BIN_DIR = path.join(path.dirname(REPO), 'resources', 'bin');
    assert.deepEqual(hlsBinaries(), {
      ytdlp: path.join(path.dirname(REPO), 'resources', 'bin', ytDlpName()),
      ffmpeg: path.join(path.dirname(REPO), 'resources', 'bin', ffmpegName()),
    });
  } finally {
    if (saved === undefined) delete process.env.VD_BIN_DIR;
    else process.env.VD_BIN_DIR = saved;
  }
});

test('分段地址每下 1 段就过期（HTTP 403）：自动续传到下完，结果和不出错时逐字节相同', { timeout: TIMEOUT }, async () => {
  const { file: refFile } = await downloadReference('ref');
  assertPlayable(refFile, { label: '参考' });
  hls.expiring.every = 1;
  hls.expiring.servedSegments = [];
  const outDir = path.join(fixture, 'expiring');
  const events = [];
  const asks = []; // 引擎每跑一次 yt-dlp 之前来要播放列表地址时，是不是要「换个新的」
  const rejectedBefore = hls.expiring.rejected;

  const { files } = await downloadHlsStream(
    ({ refresh }) => {
      asks.push(refresh);
      return EXPIRING;
    },
    {
      outDir,
      title: '视频 (1)',
      headers: { Referer: 'https://example.test/watch/1', 'User-Agent': 'vd-test' },
      onEvent: (e) => events.push(e),
      backoffMs: 10,
    },
  );

  assert.equal(files.length, 1);
  assert.equal(path.basename(files[0]), '视频 (1).mp4');
  assert.deepEqual(readFileSync(files[0]), readFileSync(refFile), '续传下载的文件应与一次下完的逐字节相同');
  // 每一段都只下了一次：没有从头重下
  assert.deepEqual(hls.expiring.servedSegments, SEGMENTS);
  assert.ok(hls.expiring.rejected - rejectedBefore >= 30, '分段确实因为过期被拒过');
  const logs = events.filter((e) => e.type === 'info').map((e) => e.raw);
  assert.match(logs.join('\n'), /HTTP 403[\s\S]*从第 2 段继续（第 1 次重试）/, '日志应说明原因，以及从第几段继续');
  assert.ok(events.some((e) => e.type === 'progress' && e.percent === 100), '应有进度事件');
  assert.ok(asks.length >= 4, `每跑一次 yt-dlp 都要一次播放列表地址（实际 ${asks.length} 次）`);
  assert.ok(asks.every((r) => r === false), '播放列表地址没变，每次都有进展：不需要换新地址（也就不用重新打开网页）');
  const last = hls.requests.filter((r) => r.path === '/expiring/seg003.ts').pop();
  assert.equal(last?.headers.referer, 'https://example.test/watch/1', '请求分段时带上网页地址');
  assert.equal(last?.headers['user-agent'], 'vd-test');
  assert.equal(existsSync(path.join(outDir, '视频 (1).part')), false, '下完之后不留临时文件');
});

test('播放列表地址自己过期（连一段都没往下走）：换个新地址后接着下', { timeout: TIMEOUT }, async () => {
  const { file: refFile } = await downloadReference('ref');
  hls.expiring.every = 1;
  hls.expiring.servedSegments = [];
  const outDir = path.join(fixture, 'dead-playlist');
  const dead = `${at('/expiring/seg000.ts')}?tok=0`; // 永远 403 的地址：相当于过期的播放列表地址
  const asks = [];
  const infos = [];
  // 和 downloadMissav 一样：拿到过期的地址就一直用它（yt-dlp 重新读一遍播放列表就能拿到新的分段地址），
  // 引擎要新地址时才换
  let playlist = dead;

  const { files } = await downloadHlsStream(
    ({ refresh }) => {
      asks.push(refresh);
      if (refresh) playlist = EXPIRING;
      return playlist;
    },
    { outDir, title: 'v', onEvent: (e) => e.type === 'info' && infos.push(e.raw), backoffMs: 10 },
  );

  assert.deepEqual(readFileSync(files[0]), readFileSync(refFile));
  assert.deepEqual(hls.expiring.servedSegments, SEGMENTS);
  // 第一次用过期地址、一段都没下到 → 要新地址；之后每次都有进展，一直是同一个地址
  assert.deepEqual(asks, [false, true, false, false, false]);
  assert.match(infos[0], /第 1 次重试/);
});

test('某一段一直拿不到：明确报错、不出半截文件；断点保留，修好后再试只下剩下的', { timeout: TIMEOUT }, async () => {
  const { file: refFile } = await downloadReference('ref');
  const outDir = path.join(fixture, 'flaky');
  Object.assign(hls.flaky, { broken: true, segment: 1, served: [] });
  const infos = [];

  await assert.rejects(
    downloadHlsStream(() => FLAKY, { outDir, title: 'v', onEvent: (e) => e.type === 'info' && infos.push(e.raw), backoffMs: 10 }),
    (err) => {
      assert.match(err.message, /已下好 1 段，断点已保留，点「重试」会从这里继续/);
      assert.match(err.message, /fragment 2 not found/, '带着 yt-dlp 的原始报错，方便排查');
      return true;
    },
  );
  assert.equal(existsSync(path.join(outDir, 'v.mp4')), false, '下不完就不能有「成功」的文件');
  const kept = hlsResumePoint(outDir, 'v');
  assert.equal(kept?.index, 1, '断点：第 0 段已下好');
  assert.equal(kept?.bytes, statSync(path.join(segDir, 'seg000.ts')).size);
  // 换了地址也没用的失败，试几次就停，不能没完没了
  assert.ok(infos.length >= 2 && infos.length <= 4, `重试日志的条数应在 2~4 之间，实际 ${infos.length}`);

  // 「修好」之后重试：从第 1 段接着下，第 0 段不重下
  hls.flaky.broken = false;
  hls.flaky.served = [];
  const { files } = await downloadHlsStream(() => FLAKY, { outDir, title: 'v', backoffMs: 10 });
  assert.deepEqual(hls.flaky.served, SEGMENTS.slice(1), '只下了没下完的 3 段');
  assert.deepEqual(readFileSync(files[0]), readFileSync(refFile));
  assert.equal(hlsResumePoint(outDir, 'v'), null, '下完之后断点清掉');
});

test('终止：yt-dlp 立刻停下并保留断点；之后接着下，只下没下完的', { timeout: TIMEOUT }, async () => {
  const { file: refFile } = await downloadReference('ref');
  const outDir = path.join(fixture, 'abort');
  hls.slowDown(1500, '/ts-plain/'); // 每个请求 1.5 秒：留出「下到一半」的时间窗口
  const ctrl = new AbortController();
  const pending = downloadHlsStream(() => PLAIN, { outDir, title: 'v', signal: ctrl.signal });

  await until('第 0 段下完', () => hlsResumePoint(outDir, 'v')?.index === 1);
  ctrl.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  const part = path.join(outDir, 'v.mp4.part');
  const size = statSync(part).size;
  const requests = hls.requests.length;
  await sleep(2500);
  assert.equal(statSync(part).size, size, '终止之后文件不应继续变大');
  assert.equal(hls.requests.length, requests, '终止之后不应再有新的请求（yt-dlp 进程已经结束）');

  hls.slowDown(0);
  const { files } = await downloadHlsStream(() => PLAIN, { outDir, title: 'v' });
  const after = hls.requests.slice(requests).filter((r) => /^\/ts-plain\/seg\d+\.ts$/.test(r.path)).map((r) => r.path);
  assert.deepEqual(after, SEGMENTS.slice(1).map((s) => `/ts-plain/${s}`), '接着下：只请求没下完的 3 段');
  assert.deepEqual(readFileSync(files[0]), readFileSync(refFile));
});

test('网页 → 提取播放列表 → 下载（无头 Edge）：页面里的流地址带过期 token 也能下完', { timeout: TIMEOUT, skip: !findEdge() || process.env.CI ? '需要无头 Edge，只在本地跑' : false }, async () => {
  const { file: refFile } = await downloadReference('ref');
  hls.expiring.every = 2;
  hls.expiring.servedSegments = [];
  const outDir = path.join(fixture, 'page');
  const events = [];
  const { files } = await downloadMissav(PAGE, { outDir, onEvent: (e) => events.push(e) });

  assert.equal(path.basename(files[0]), '测试视频 - 某站点.mp4', '文件名用网页标题');
  assert.deepEqual(readFileSync(files[0]), readFileSync(refFile), '和直接给播放列表地址下载的结果一样');
  assert.deepEqual(hls.expiring.servedSegments, SEGMENTS);
  const infos = events.filter((e) => e.type === 'info').map((e) => e.raw);
  assert.equal(infos.filter((l) => l.includes('正在通过 Cloudflare 验证')).length, 1, '只打开了一次网页（分段过期不需要重新打开）');
  assert.ok(infos.some((l) => /从第 3 段继续（第 1 次重试）/.test(l)), '下好 2 段后地址过期，从第 3 段继续');
  assert.ok(events.some((e) => e.type === 'title' && e.title === '测试视频 - 某站点'));
});

// ---------------------------------------------------------------------------
// 通用下载路径（src/downloader.mjs， yt-dlp）：所有没写专门引擎的站点都走它。
// 不少视频站的流是 HLS / DASH，分段地址带有效期（实测有的站点只有 1 小时），
// 下载超过这个时间，后面的分段就全都拿不到 —— 以前会留下一个半截文件还显示「完成」。
// ---------------------------------------------------------------------------

let plainFile; // 不出错时下载的结果：后面几个用例都要求和它一样

test('通用下载路径：分段地址每下 1 段就过期 → 每趟都从断点接着下，直到下完；结果和不出错时相同', { timeout: TIMEOUT }, async () => {
  const outDir = path.join(fixture, 'generic');
  plainFile = (await download(PLAIN, { outDir, taskId: 'plain' })).files[0];
  assertPlayable(plainFile, { label: '参考' });

  hls.expiring.every = 1;
  hls.expiring.servedSegments = [];
  const rejectedBefore = hls.expiring.rejected;
  const events = [];
  const { files } = await download(EXPIRING, { outDir, taskId: 'expiring', onEvent: (e) => events.push(e) });

  assert.equal(files.length, 1);
  assert.notEqual(files[0], plainFile, '同名文件不覆盖，另存一份');
  assert.deepEqual(readFileSync(files[0]), readFileSync(plainFile), '续传下载的文件应与一次下完的逐字节相同');
  assert.deepEqual(hls.expiring.servedSegments, SEGMENTS, '每一段都只下了一次：没有从头重下');
  assert.ok(hls.expiring.rejected - rejectedBefore >= 30, '分段确实因为过期被拒过');
  const retries = events.filter((e) => e.type === 'info' && String(e.raw).startsWith('[retry]')).map((e) => e.raw);
  // 4 段每趟只能下到 1 段：要跑 4 趟才下完。以前最多跑 3 趟就放弃了
  assert.equal(retries.length, 3);
  assert.match(retries[0], /\[retry\] 下载中断（HTTP 403），从断点重试（第 1 次）/, '日志说明原因，并且是从断点继续');
  assert.equal(existsSync(path.join(outDir, '.vd-tmp-expiring')), false, '下完之后任务的临时目录清掉');
});

test('通用下载路径：某一段一直拿不到 → 明确报错、不留半截文件；断点保留，修好后重试只下剩下的', { timeout: TIMEOUT }, async () => {
  assert.ok(plainFile, '依赖上一个用例生成的参考文件');
  const outDir = path.join(fixture, 'generic-flaky');
  Object.assign(hls.flaky, { broken: true, segment: 1, served: [] });

  await assert.rejects(
    download(FLAKY, { outDir, taskId: 't1' }),
    (err) => {
      assert.match(err.message, /fragment 2 not found/, '带着 yt-dlp 的原始报错');
      assert.doesNotMatch(err.message, /提示：连不上/, '不是连不上站点，不该给配代理的提示');
      return true;
    },
  );
  assert.deepEqual(readdirSync(outDir).filter((f) => !f.startsWith('.')), [], '目标目录里不能有被当成「下载成功」的文件');
  const work = path.join(outDir, '.vd-tmp-t1');
  const ytdl = readdirSync(work).find((f) => f.endsWith('.ytdl'));
  const part = ytdl && ytdl.slice(0, -'.ytdl'.length) + '.part';
  assert.ok(ytdl && existsSync(path.join(work, part)), `临时目录里留着没下完的文件: ${readdirSync(work)}`);
  assert.equal(JSON.parse(readFileSync(path.join(work, ytdl), 'utf8')).downloader.current_fragment.index, 1, '断点：第 0 段已下好');

  hls.flaky.broken = false;
  hls.flaky.served = [];
  const { files } = await download(FLAKY, { outDir, taskId: 't1' }); // 点「重试」：同一个任务 id → 同一个临时目录
  assert.deepEqual(hls.flaky.served, SEGMENTS.slice(1), '只下了没下完的 3 段');
  assert.deepEqual(readFileSync(files[0]), readFileSync(plainFile));
  assert.equal(existsSync(path.join(outDir, '.vd-tmp-t1')), false, '下完之后临时目录清掉');
});

test('通用下载路径：连不上站点、又没配代理 → 报错里提示可以配置代理', { timeout: TIMEOUT }, async () => {
  const srv = http.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r)); // 立刻关掉：这个端口上没有任何东西在听
  const outDir = path.join(fixture, 'unreachable');
  await assert.rejects(download(`http://127.0.0.1:${port}/x.mp4`, { outDir, taskId: 'u1' }), /提示：连不上这个站点[\s\S]*设置里填好代理/);
});
