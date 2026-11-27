#!/usr/bin/env node
// 大文件回归：一个 4GiB 出头的 HLS 视频下载 + 转成 MP4，全程跑完且结果正确。
//
//   node tests/android-big-file-check.mjs                                 只连着一台设备
//   ANDROID_SERIAL=emulator-5556 node tests/android-big-file-check.mjs    连着多台时指定
//
// 用户报过的 bug 就出在这里：视频下到 80% 开始合成时报 NegativeArraySizeException: -400254016 ——
// TS 文件超过 2GiB 后，文件长度被当成 Int 处理。所以这个用例的输入必须真的超过 2GiB，
// 小文件的用例（tests/android-media-check.mjs、tests/android-e2e.mjs）覆盖不到。
//
// 需要：
//   · 一台存储空余 ≥ 11GB 的模拟器（默认的 AVD 一般只有几 GB：新建一个，把 config.ini 里的
//     disk.dataPartition.size 调成 17179869184），并且能 adb root（google_apis 镜像）
//   · 已经装好 debug APK（npm run android:apk 后 adb install -r）；电脑上有 ffmpeg
//   · 环境变量 VD_BIG_DIR 指定测试源放在哪（默认系统临时目录）。第一次运行用 ffmpeg 生成，
//     约 4GiB、一两分钟，之后复用
//
// 做法：模拟器的网络很慢，真下 4GB 要一个多小时。所以把前面 597/600 段直接放进 App 的缓存目录，
// 并写好续传状态；App 接着只下载最后 3 段，然后走完整的合成流程 —— 也就是出过崩溃的那一步，
// 以及后面所有「文件超过 2GiB」才会遇到的路径（系统 TS 解析、封装、写进下载目录）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ARTIFACTS, adb, api, connect, resetUi, screenshot, sleep, startApp, waitFor } from './android-e2e.mjs';
import { FFMPEG, assertAVSync, assertPlayable, assertSameAudio, assertSameVideo } from './media-tools.mjs';

const PKG = 'com.sillyshalong.videodownloader';
const HOST = '10.0.2.2'; // 模拟器里指向宿主机
const DIR = process.env.VD_BIG_DIR || path.join(tmpdir(), 'vd-big-hls');
const SECONDS = 6000; // 100 分钟、5fps 的无损噪声画面：约 4GiB
const SEGMENTS = SECONDS / 10; // 每 10 秒一段
const PRESEEDED = SEGMENTS - 3; // 预先放进缓存的段数：App 只需要接着下最后 3 段
const GIB = 1024 ** 3;
const PUSH_TIMEOUT = 30 * 60_000;

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} 退出码 ${r.status}\n${(r.stderr || '').split('\n').slice(-8).join('\n')}`);
  return r.stdout;
}

/** 截图只是留证据：设备断线时截不了，也不该把真正的失败原因盖掉 */
function screenshotQuietly(name) {
  try {
    screenshot(name);
  } catch {
    /* 忽略 */
  }
}

/** 设备断线（device offline）后，等它恢复在线 */
async function waitDevice() {
  for (let i = 0; i < 90 && adb(['get-state'], { allowFail: true }).trim() !== 'device'; i++) await sleep(2000);
  await sleep(1000);
}

/** 做一件事，失败了（多半是连接断了）等设备恢复再重来 */
async function withRetries(what, attempt, tries = 6) {
  for (let i = 1; ; i++) {
    let out = null;
    try {
      out = attempt();
    } catch {
      /* 下面统一按失败处理 */
    }
    if (out) return out;
    if (i >= tries) throw new Error(`${what}：试了 ${tries} 次都没成功`);
    console.log(`  ${what}没成功，等设备恢复后重试（第 ${i} 次）`);
    await waitDevice();
  }
}

/**
 * 把设备上的文件拉回电脑，并核对 SHA-256。
 * 几个 GiB 的文件用 adb pull 拉到一半连接常会断（device offline）：所以分成小块拉，每块核对长度、失败重来；
 * 全部拉完再和设备上算的 SHA-256 对一遍 —— 只核对长度的话，内容错了也看不出来。
 */
async function pullVerified(remote, local, size) {
  const MIB = 1024 * 1024;
  const CHUNK = 200 * MIB; // 要小于 adb() 的 maxBuffer（256MB）
  rmSync(local, { force: true });
  mkdirSync(path.dirname(local), { recursive: true });
  const fd = openSync(local, 'w');
  try {
    for (let offset = 0; offset < size; ) {
      const take = Math.min(CHUNK, size - offset);
      // 整数 MiB 的块用 dd 按块跳着读；最后不是整数 MiB 的尾巴取「文件末尾 N 字节」
      //（dd 的 count 不能带小数；toybox 的 tail -c +N 起点又不能超过 2^32）
      const args =
        take % MIB === 0
          ? ['exec-out', 'dd', `if=${remote}`, 'bs=1048576', `skip=${offset / MIB}`, `count=${take / MIB}`, 'status=none']
          : ['exec-out', 'tail', '-c', String(take), remote];
      const chunk = await withRetries(`拉取 ${remote} 的 ${(offset / MIB).toFixed(0)} MiB 处`, () => {
        const out = adb(args, { binary: true, allowFail: true, timeout: PUSH_TIMEOUT });
        return out.length === take ? out : null;
      });
      writeSync(fd, chunk, 0, chunk.length, offset);
      offset += take;
    }
  } finally {
    closeSync(fd);
  }
  assert.equal(statSync(local).size, size, `${local}: 大小不对`);
  const hash = createHash('sha256');
  for await (const buf of createReadStream(local)) hash.update(buf);
  const onDevice = (await withRetries(`读取 ${remote} 的 SHA-256`, () => adb(['shell', 'sha256sum', remote], { allowFail: true, timeout: PUSH_TIMEOUT }).trim() || null))
    .split(/\s+/)[0]
    .toLowerCase();
  assert.equal(hash.digest('hex'), onDevice, `${remote}: 拉回电脑的内容与设备上的不一致`);
}

/** 生成（或复用）测试源：HLS 分段 + ffmpeg 自己合成的参考文件 */
function prepareFixture() {
  const hls = path.join(DIR, 'hls');
  const ref = path.join(DIR, 'ref.mp4');
  if (existsSync(path.join(hls, 'index.m3u8')) && existsSync(ref) && statSync(ref).size > 2 * GIB) return { hls, ref };
  console.log(`生成测试源（约 4GiB，一两分钟）→ ${DIR}`);
  mkdirSync(hls, { recursive: true });
  const win = (p) => p.split(path.sep).join('/');
  // 画面是逐帧随机的噪声、无损编码（qp 0）：几乎不可压缩，所以不用编码很久就能得到很大的文件；
  // 只有 5fps 是为了让后面的逐帧比对不用解几十万帧。音频是 48kHz 立体声 AAC。
  run(FFMPEG, [
    '-hide_banner', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'nullsrc=s=320x180:r=5,noise=alls=100:allf=t+u,format=yuv420p',
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${SECONDS}`,
    '-t', String(SECONDS),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p', '-g', '25',
    '-c:a', 'aac', '-b:a', '96k', '-ac', '2', '-ar', '48000',
    '-hls_time', '10', '-hls_list_size', '0', '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', `${win(hls)}/seg%05d.ts`,
    `${win(hls)}/index.m3u8`,
  ]);
  run(FFMPEG, [
    '-hide_banner', '-nostdin', '-y',
    '-protocol_whitelist', 'file,crypto,data', '-allowed_extensions', 'ALL',
    '-i', `${win(hls)}/index.m3u8`, '-c', 'copy', win(ref),
  ]);
  return { hls, ref };
}

async function main() {
  // 连着多台设备时必须指定
  const serials = adb(['devices']).split('\n').slice(1).map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
  assert.ok(serials.length > 0, '没有连接的设备 / 模拟器');
  assert.ok(
    serials.length === 1 || process.env.ANDROID_SERIAL,
    `连着 ${serials.length} 台设备，请用 ANDROID_SERIAL 指定一台: ${serials.join(', ')}`,
  );

  const { hls, ref } = prepareFixture();
  const playlist = readFileSync(path.join(hls, 'index.m3u8'), 'utf8');
  const segNames = playlist.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.equal(segNames.length, SEGMENTS, `测试源应有 ${SEGMENTS} 段，实际 ${segNames.length}`);
  const sizes = segNames.map((n) => statSync(path.join(hls, n)).size);
  const totalBytes = sizes.reduce((a, b) => a + b, 0);
  const preloaded = sizes.slice(0, PRESEEDED).reduce((a, b) => a + b, 0);
  assert.ok(preloaded > 2 ** 31, `预先放进缓存的部分必须超过 2GiB 才有意义（现在是 ${(preloaded / GIB).toFixed(2)} GiB）`);
  // 与 App（HlsDownloader.fingerprint）同一种算法：「段数|总时长（毫秒，四舍五入）」
  const durations = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]));
  const fingerprint = `${segNames.length}|${Math.round(durations.reduce((a, b) => a + b, 0) * 1000)}`;
  console.log(
    `测试源: ${segNames.length} 段，共 ${(totalBytes / GIB).toFixed(2)} GiB；预先放进缓存 ${PRESEEDED} 段（${(preloaded / GIB).toFixed(2)} GiB），` +
      `App 接着下最后 ${SEGMENTS - PRESEEDED} 段`,
  );

  // 设备：root（往 App 的私有缓存里放文件需要）→ 清掉上次运行可能留下的几个 GB → 再看存储空间够不够
  adb(['root'], { allowFail: true });
  await sleep(2);
  assert.equal(adb(['shell', 'id', '-u']).trim(), '0', '需要 root（adb root；google_apis 镜像支持，playstore 镜像不支持）');
  adb(['shell', `rm -rf /data/local/tmp/vd-seed /data/data/${PKG}/cache/parts/*`]);
  const availKb = Number(adb(['shell', 'df', '-k', '/data']).split('\n')[1].trim().split(/\s+/)[3]);
  const needKb = Math.ceil((totalBytes + statSync(ref).size + GIB) / 1024);
  assert.ok(
    availKb > needKb,
    `设备存储不够：需要约 ${(needKb / 1024 / 1024).toFixed(1)} GB 空余，只剩 ${(availKb / 1024 / 1024).toFixed(1)} GB（新建一个 disk.dataPartition.size=16G 的模拟器）`,
  );

  // 本地 HLS 服务：先「扣住」分段请求不回应，等缓存放好再放行
  const served = [];
  let hold = true;
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1));
    const file = path.join(hls, path.normalize(name));
    if (!file.startsWith(hls) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    if (name.endsWith('.m3u8')) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' }).end(playlist);
      return;
    }
    if (hold) return; // 先不回应：任务会停在「下载第一段」
    served.push(name);
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': statSync(file).size, 'Cache-Control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '0.0.0.0', r));
  const port = server.address().port;
  const findTask = async (id) => (await api.get('/api/tasks')).tasks.find((x) => x.id === id);

  try {
    // 1) 提交任务，让它停在「下载第一段」，然后停掉 App（释放缓存文件）
    await startApp();
    let c = await connect();
    const r = await api.post('/api/download', {
      input: `http://${HOST}:${port}/index.m3u8`,
      quality: null,
      audio: false,
      outDir: null,
      playlistItems: null,
    });
    const t = r.tasks?.[0];
    assert.ok(t, `提交失败: ${JSON.stringify(r)}`);
    await waitFor('App 开始下载分段（缓存目录已建好）', async () => (await findTask(t.id))?.stage?.startsWith('下载视频分段') ?? false, {
      timeout: 60000,
    });
    await sleep(1500);
    adb(['shell', 'am', 'force-stop', PKG]);
    c.ws.close();

    // 2) 把前 N-3 段放进 App 的缓存，写好续传状态（与 App 自己写的一模一样）
    const cache = `/data/data/${PKG}/cache/parts/${t.id}`;
    adb(['shell', `rm -rf ${cache} /data/local/tmp/vd-seed && mkdir -p ${cache} /data/local/tmp/vd-seed`]);
    console.log(`把 ${(preloaded / GIB).toFixed(2)} GiB 推到设备 …`);
    // 目录后面要跟「/.」才是「推这个目录里的文件」；路径用正斜杠（Windows 上结尾的反斜杠会把引号吃掉）
    adb(['push', `${hls.split(path.sep).join('/')}/.`, '/data/local/tmp/vd-seed/'], { timeout: PUSH_TIMEOUT });
    adb(['shell', `cd /data/local/tmp/vd-seed && ls seg*.ts | sort | head -n ${PRESEEDED} | xargs cat > ${cache}/stream.ts`], { timeout: PUSH_TIMEOUT });
    const pushed = Number(adb(['shell', 'cd /data/local/tmp/vd-seed && ls seg*.ts | wc -l']).trim());
    adb(['shell', 'rm -rf /data/local/tmp/vd-seed']);
    assert.equal(pushed, SEGMENTS, `推进设备的分段数应为 ${SEGMENTS}，实际 ${pushed}`);
    const rawLength = Number(adb(['shell', `stat -c %s ${cache}/stream.ts`]).trim());
    assert.equal(rawLength, preloaded, '推进缓存的分段总大小应与测试源一致');
    adb(['shell', `printf '2\\n${PRESEEDED}\\n${rawLength}\\n${fingerprint}\\n' > ${cache}/stream.done`]);
    adb(['shell', `chown -R $(stat -c %u:%g /data/data/${PKG}) ${cache} && restorecon -R ${cache}`]);
    console.log(`缓存就位：stream.ts ${(rawLength / GIB).toFixed(2)} GiB + 续传状态（已完成 ${PRESEEDED} 段）`);

    // 3) 重新打开 App：任务显示为「暂停」；放行分段；真实点击「恢复」
    await startApp();
    c = await connect();
    const paused = await waitFor('重启后任务显示为暂停', async () => {
      const x = await findTask(t.id);
      return x?.status === 'paused' ? x : false;
    }, { timeout: 30000 });
    assert.ok(paused.log.some((l) => l.includes('应用重启')), '日志应说明是重启打断的');
    hold = false;
    await resetUi(c);
    await c.tap('.trow [data-act="retry"]');

    // 4) 等它做完：下载最后 3 段 → 合成 4GiB 的 MP4 → 存进下载目录
    const t0 = Date.now();
    let lastStage = '';
    const done = await waitFor('大文件下载并合成完成', async () => {
      const x = await findTask(t.id);
      if (x && (x.status === 'done' || x.status === 'error')) return x;
      if (x && x.stage !== lastStage) {
        lastStage = x.stage;
        console.log(`  [${((Date.now() - t0) / 60000).toFixed(1)} 分] ${x.stage} ${x.percent?.toFixed?.(1) ?? ''}%`);
      }
      return false;
    }, {
      timeout: 60 * 60_000,
      interval: 2000,
      onFail: async (e) => {
        const x = await findTask(t.id);
        e.message += `\n  任务当前状态: ${JSON.stringify({ status: x?.status, stage: x?.stage, percent: x?.percent, error: x?.error, log: x?.log?.slice(-12) })}`;
      },
    });
    screenshotQuietly('big-file');
    const text = (done.log || []).join('\n');
    assert.equal(done.status, 'done', `大文件任务失败:\n${text}`);
    assert.match(text, new RegExp(`分段从断点继续下载（已完成 ${PRESEEDED} 段，共 ${SEGMENTS} 段）`), '应从预置的断点接着下');
    assert.doesNotMatch(text, /无法转换成 MP4/, '应当成功转成 MP4，而不是退回保存原始 TS');
    // 只下载了最后 3 段，每段一次：前面 597 段没有重下
    assert.deepEqual([...served].sort(), segNames.slice(PRESEEDED), 'App 应只请求最后 3 段');
    assert.ok(done.sizeBytes > 2 ** 31, `输出应超过 2GiB: ${done.sizeBytes}`);
    const onDevice = Number(adb(['shell', `stat -c %s "/sdcard/${done.file}"`]).trim());
    assert.equal(onDevice, done.sizeBytes, '下载目录里的文件大小应与任务记录一致');
    console.log(`完成，用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟；输出 ${done.file}（${(done.sizeBytes / GIB).toFixed(2)} GiB）`);

    // 5) 结果正确性：拉回电脑，和 ffmpeg 的参考逐帧比对
    mkdirSync(ARTIFACTS, { recursive: true });
    const local = path.join(ARTIFACTS, 'big-file.mp4');
    console.log('拉回电脑（校验 SHA-256），再和 ffmpeg 的参考比对 …');
    await pullVerified(`/sdcard/${done.file}`, local, done.sizeBytes);
    const playable = assertPlayable(local, { label: '大文件' });
    const frames = assertSameVideo(local, ref, '大文件（设备上合成）vs ffmpeg 参考');
    assertSameAudio(local, ref, '大文件：音频（设备上合成 vs ffmpeg 参考）');
    const av = assertAVSync(local, ref, '大文件：音画起点关系（设备上合成 vs ffmpeg 参考）');
    console.log(
      `与 ffmpeg 参考逐帧一致：${frames} 帧，音频解码一致；时长 ${playable.duration.toFixed(1)}s；` +
        `音画起点：视频比音频${av.mine >= 0 ? '晚' : '早'} ${(Math.abs(av.mine) * 1000).toFixed(1)}ms（参考 ${(Math.abs(av.ref) * 1000).toFixed(1)}ms）`,
    );
    rmSync(local, { force: true });
    adb(['shell', `rm -f "/sdcard/${done.file}"`]); // 4GiB 的产物不必留在模拟器里
    await api.post('/api/history/delete', { id: t.id }).catch(() => {});
    c.ws.close();
  } catch (e) {
    screenshotQuietly('FAIL-big-file');
    throw e;
  } finally {
    server.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
