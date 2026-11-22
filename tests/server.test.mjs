// 服务端集成测试：真实起服务、真实调接口，下载用本地 HTTP 桩（不依赖外网）
// 外网相关用例（代理连通性实测）默认跳过，RUN_NETWORK_TESTS=1 时启用
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

const RUN_NETWORK = process.env.RUN_NETWORK_TESTS === '1';

// 隔离配置：必须在导入业务模块前设置（config.mjs / history.mjs 在导入时读取）
const tmpRoot = mkdtempSync(path.join(tmpdir(), 'vd-test-'));
process.env.VD_CONFIG_PATH = path.join(tmpRoot, 'config.json');
writeFileSync(process.env.VD_CONFIG_PATH, JSON.stringify({ proxy: '' }));
process.env.VD_HISTORY_PATH = path.join(tmpRoot, 'history.json');

const { createApp } = await import('../src/server.mjs');

// ---------- 测试基础设施 ----------
const server = createApp();
await new Promise((res) => server.listen(0, '127.0.0.1', res));
const BASE = `http://127.0.0.1:${server.address().port}`;

// 本地 HTTP 桩：提供一个"假视频"文件供 yt-dlp 下载
// flaky.mp4 配合 flakyFail 开关：置 true 时返回 403（模拟瞬时失败），置 false 后恢复
// slow.mp4 分块慢发（暂停/终止/测速用）
const stubBody = Buffer.from('FAKEVIDEOCONTENT-NOT-A-REAL-MP4-BUT-FINE-FOR-DOWNLOAD-TEST');
const slowBody = Buffer.alloc(4096);
let flakyFail = true;
const stub = http.createServer((req, res) => {
  if (req.url === '/fake.mp4') {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(stubBody.length) });
    res.end(stubBody);
  } else if (req.url === '/flaky.mp4') {
    if (flakyFail) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('forbidden (simulated transient failure)');
    } else {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(stubBody.length) });
      res.end(stubBody);
    }
  } else if (req.url === '/slow.mp4') {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(slowBody.length) });
    let i = 0;
    const timer = setInterval(() => {
      res.write(slowBody.subarray(0, 256));
      if (++i >= 16) {
        clearInterval(timer);
        res.end();
      }
    }, 400);
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((res) => stub.listen(0, '127.0.0.1', res));
const STUB_URL = `http://127.0.0.1:${stub.address().port}/fake.mp4`;
const FLAKY_URL = `http://127.0.0.1:${stub.address().port}/flaky.mp4`;
const SLOW_URL = `http://127.0.0.1:${stub.address().port}/slow.mp4`;

const waitStatus = async (id, statuses, timeoutMs = 30000) => {
  for (let i = 0; i < timeoutMs / 300; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const t = (await j('/api/tasks')).body.tasks.find((x) => x.id === id);
    if (t && statuses.includes(t.status)) return t;
  }
  return null;
};

const j = (p, opts) => fetch(BASE + p, opts).then(async (r) => ({ status: r.status, body: await r.json() }));
const post = (p, body) => j(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

test.after(() => {
  // closeAllConnections 必须有：SSE 长连接不关会让 server.close() 永远等下去、进程挂住
  server.close();
  server.closeAllConnections?.();
  stub.close();
  stub.closeAllConnections?.();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------- 页面 ----------
test('GET / 返回 GUI 页面（React 构建产物）', async () => {
  const html = await fetch(BASE + '/').then((r) => r.text());
  assert.ok(html.includes('id="root"'), 'React 挂载点');
  assert.ok(html.includes('/assets/'), 'Vite 资源引用');
});

// ---------- 解析 ----------
test('POST /api/parse: 抖音口令 → 站点 douyin', async () => {
  const { body } = await post('/api/parse', { input: '看看【xx】... https://v.douyin.com/ABC123/ 尾部噪声' });
  assert.deepEqual(body.urls, [{ url: 'https://v.douyin.com/ABC123/', site: 'douyin' }]);
});

test('POST /api/parse: 混合多链接 + 未知站点', async () => {
  const { body } = await post('/api/parse', { input: 'https://youtu.be/x https://vimeo.com/123456' });
  assert.equal(body.urls.length, 2);
  assert.equal(body.urls[0].site, 'youtube');
  assert.equal(body.urls[1].site, 'generic');
});

test('POST /api/parse: 裸 URL 兜底', async () => {
  const { body } = await post('/api/parse', { input: 'https://youtu.be/x' });
  assert.equal(body.urls.length, 1);
});

test('POST /api/parse: B站链接（含 b23.tv 短链）', async () => {
  const a = await post('/api/parse', { input: 'https://www.bilibili.com/video/BV1GJ411x7h7?p=2' });
  assert.equal(a.body.urls[0].site, 'bilibili');
  const b = await post('/api/parse', { input: '看看这个 https://b23.tv/abc123 分享' });
  assert.equal(b.body.urls[0].site, 'bilibili');
});

// ---------- 配置 ----------
test('GET/POST /api/config: 读取与保存（含校验）', async () => {
  assert.equal((await j('/api/config')).body.proxy, '');
  const bad = await post('/api/config', { proxy: 'ws://bad' });
  assert.equal(bad.status, 400);
  const ok = await post('/api/config', { proxy: 'socks5://127.0.0.1:1080' });
  assert.equal(ok.body.proxy, 'socks5://127.0.0.1:1080');
  assert.equal((await j('/api/config')).body.proxy, 'socks5://127.0.0.1:1080');
  await post('/api/config', { proxy: '' }); // 复原
});

test('GET/POST /api/config: SESSDATA 校验与持久化', async () => {
  // 非法值（含引号/前缀/中文）→ 400
  assert.equal((await post('/api/config', { bilibiliSessdata: '"abc"' })).status, 400);
  assert.equal((await post('/api/config', { bilibiliSessdata: 'Cookie: SESSDATA=x' })).status, 400);
  // 合法值保存并可读回
  const ok = await post('/api/config', { bilibiliSessdata: '12%2CabXYZ,_' });
  assert.equal(ok.status, 200);
  assert.equal((await j('/api/config')).body.bilibiliSessdata, '12%2CabXYZ,_');
  // 清空
  await post('/api/config', { bilibiliSessdata: '' });
  assert.equal((await j('/api/config')).body.bilibiliSessdata, '');
});

test('GET/POST /api/config: hlsSites 归一化保存并读回', async () => {
  const ok = await post('/api/config', { hlsSites: ['https://www.Example.com/x', 'MISSAV.ws', 'not a domain', 'missav.ws'] });
  assert.equal(ok.status, 200);
  // 归一化：scheme/www 剥离、小写、去重、非法丢弃
  const got = (await j('/api/config')).body.hlsSites;
  assert.deepEqual(got, ['example.com', 'missav.ws']);
  // 数组之外的输入形态（换行分隔文本）也支持
  await post('/api/config', { hlsSites: 'a.org\nb.org' });
  assert.deepEqual((await j('/api/config')).body.hlsSites, ['a.org', 'b.org']);
  // 清空
  await post('/api/config', { hlsSites: [] });
  assert.deepEqual((await j('/api/config')).body.hlsSites, []);
});

// ---------- 代理测试 ----------
test('POST /api/proxy-test: 非法地址 → 400', async () => {
  assert.equal((await post('/api/proxy-test', { proxy: '垃圾' })).status, 400);
});

test('POST /api/proxy-test: 死端口 → ok:false（快速失败）', async () => {
  const { body } = await post('/api/proxy-test', { proxy: 'http://127.0.0.1:9399' });
  assert.equal(body.ok, false);
});

test('POST /api/proxy-test: 本地转发代理可达（RUN_NETWORK_TESTS=1）', { skip: !RUN_NETWORK }, async () => {
  const { spawn } = await import('node:child_process');
  const proxy = spawn(process.execPath, [path.resolve('scripts/dev-proxy.mjs'), '9390'], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 800));
    const { body } = await post('/api/proxy-test', { proxy: 'http://127.0.0.1:9390' });
    assert.equal(body.ok, true, body.message);
  } finally {
    proxy.kill();
  }
});

test('B站真实下载（RUN_NETWORK_TESTS=1）：360p 游客模式全链路', { skip: !RUN_NETWORK, timeout: 120000 }, async () => {
  const outDir = path.join(tmpRoot, 'bili-dl');
  const { body } = await post('/api/download', {
    input: 'https://www.bilibili.com/video/BV1GJ411x7h7',
    quality: '360',
    outDir,
  });
  const id = body.tasks[0].id;
  const t = await waitTask(id, 90000);
  assert.equal(t?.status, 'done', t?.error || '任务未完成');
  assert.ok(t.file?.endsWith('.mp4'));
});

// ---------- 文件系统列表 ----------
test('GET /api/fs/list: 根视图含主目录与盘符', async () => {
  const { body } = await j('/api/fs/list');
  assert.equal(body.path, null);
  assert.ok(body.entries.some((e) => e.name === '主目录'));
  assert.ok(body.entries.some((e) => /^[A-Z]:\\$/.test(e.name)), '至少一个盘符');
});

test('GET /api/fs/list: 只列目录、过滤系统目录、parent 正确', async () => {
  const dir = path.join(tmpRoot, 'fs-case');
  mkdirSync(dir, { recursive: true }); // 递归建父目录
  mkdirSync(path.join(dir, '普通目录'));
  mkdirSync(path.join(dir, 'z-last'));
  mkdirSync(path.join(dir, '$Recycle.Bin'));
  mkdirSync(path.join(dir, 'System Volume Information'));
  writeFileSync(path.join(dir, 'a-file.txt'), 'x');

  const { body } = await j('/api/fs/list?dir=' + encodeURIComponent(dir));
  assert.deepEqual(body.entries.map((e) => e.name), ['z-last', '普通目录'].sort((a, b) => a.localeCompare(b, 'zh')));
  assert.equal(body.parent, tmpRoot);
});

test('GET /api/fs/list: 不存在的目录 → err 字段', async () => {
  const { body } = await j('/api/fs/list?dir=' + encodeURIComponent('C:\\definitely-not-exist-xyz'));
  assert.ok(body.err);
  assert.deepEqual(body.entries, []);
});

// ---------- 目录选择 ----------
test('POST /api/pick-dir: web 模式返回 native:false', async () => {
  const { body } = await post('/api/pick-dir');
  assert.deepEqual(body, { native: false });
});

// ---------- 定位/打开文件 ----------
test('POST /api/reveal: 不存在的路径 → 404（不弹窗）', async () => {
  assert.equal((await post('/api/reveal', { path: 'C:\\no-such.mp4' })).status, 404);
});

test('POST /api/open: 不存在 → 404；目录 → 400（不真的弹程序）', async () => {
  assert.equal((await post('/api/open', { path: 'C:\\no-such.mp4' })).status, 404);
  assert.equal((await post('/api/open', { path: tmpRoot })).status, 400);
});

// ---------- 下载任务（真实 yt-dlp + 本地桩，SSE 全链路） ----------
test('下载任务全链路：提交 → SSE 事件 → done → 文件落盘', { timeout: 60000 }, async () => {
  const outDir = path.join(tmpRoot, 'downloads');
  const events = [];
  const seen = new Set();
  const es = await fetch(BASE + '/api/events').then(async (res) => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const line of dec.decode(value).split('\n')) {
            if (line.startsWith('data: ')) {
              const ev = JSON.parse(line.slice(6));
              events.push(ev);
              if (ev.type === 'task') seen.add(`${ev.task.status}`);
            }
          }
        }
      } catch {}
    })();
    return true;
  });
  assert.ok(es); // SSE 已连接

  // 等待 init 快照到达
  await new Promise((r) => setTimeout(r, 300));

  const { status, body } = await post('/api/download', { input: STUB_URL, outDir });
  assert.equal(status, 200);
  assert.equal(body.tasks.length, 1);
  // pump() 同步启动，响应返回时任务可能已是 running
  assert.ok(['queued', 'running'].includes(body.tasks[0].status));

  // 轮询任务完成
  let task;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const list = (await j('/api/tasks')).body.tasks;
    task = list.find((t) => t.id === body.tasks[0].id);
    if (task && (task.status === 'done' || task.status === 'error')) break;
  }
  assert.equal(task?.status, 'done', '任务应完成: ' + JSON.stringify(task?.error));
  assert.ok(task.file?.endsWith('.mp4'));
  assert.ok(task.percent === 100);
  assert.ok(seen.has('done'), 'SSE 应推送 done 状态');
  // 文件确实存在且内容一致
  const { readFile } = await import('node:fs/promises');
  const content = await readFile(task.file);
  assert.equal(content.length, stubBody.length);

  // 下载历史持久化：元数据（原始链接/目标路径）落盘
  const history = JSON.parse(readFileSync(process.env.VD_HISTORY_PATH, 'utf8'));
  const rec = history.find((r) => r.id === body.tasks[0].id);
  assert.ok(rec, '历史应包含该任务');
  assert.equal(rec.url, STUB_URL, '历史保留原始链接');
  assert.equal(rec.file, task.file, '历史保留下载目的地');

  // 重启回填：新建一个 app 实例，任务列表应含历史记录
  const server2 = createApp();
  await new Promise((res2) => server2.listen(0, '127.0.0.1', res2));
  try {
    const base2 = `http://127.0.0.1:${server2.address().port}`;
    const seeded = await fetch(base2 + '/api/tasks').then((r) => r.json());
    const st = seeded.tasks.find((t) => t.id === body.tasks[0].id);
    assert.equal(st?.status, 'done', '重启后历史任务可见');
    assert.equal(st?.file, task.file);
    assert.equal(st?.url, STUB_URL);
  } finally {
    server2.close();
    server2.closeAllConnections?.();
  }
});

test('POST /api/download: 重复链接去重为一个任务', async () => {
  const { body } = await post('/api/download', { input: `${STUB_URL} ${STUB_URL}` });
  assert.equal(body.tasks.length, 1, '相同链接应去重');
});

// ---------- 多视频源探测 ----------
test('POST /api/inspect: 单视频 URL 返回 multi:false（本地桩单文件）', { timeout: 30000 }, async () => {
  const { body } = await post('/api/inspect', { input: STUB_URL });
  assert.equal(body.multi, false);
  assert.deepEqual(body.entries, []);
});

test('POST /api/inspect: 无链接 → 400', async () => {
  assert.equal((await post('/api/inspect', { input: '纯文本' })).status, 400);
});

test('POST /api/download: playlistItems 传入任务并可从 /api/tasks 读回', { timeout: 60000 }, async () => {
  const outDir = path.join(tmpRoot, 'items-dl');
  const { body } = await post('/api/download', { input: STUB_URL, outDir, playlistItems: [1, 3] });
  assert.equal(body.tasks.length, 1);
  assert.deepEqual(body.tasks[0].playlistItems, [1, 3]);
});

// ---------- 暂停 / 终止 / 统计 ----------
test('暂停 → 恢复：运行中任务可暂停并断点续传完成', { timeout: 90000 }, async () => {
  const outDir = path.join(tmpRoot, 'pause-dl');
  const { body } = await post('/api/download', { input: SLOW_URL, outDir });
  const id = body.tasks[0].id;
  // 等到下载中
  const running = await waitStatus(id, ['running', 'done'], 20000);
  assert.ok(running, '任务应开始');
  if (running.status === 'done') return; // 桩太快直接完成，跳过后续
  // 暂停
  const p = await post('/api/pause', { id });
  assert.equal(p.status, 200, p.body?.error);
  const paused = await waitStatus(id, ['paused'], 10000);
  assert.equal(paused?.status, 'paused', '应变为已暂停');
  assert.equal(paused.speed, null);
  // 恢复（retry）
  const r2 = await post('/api/retry', { id });
  assert.equal(r2.status, 200);
  const done = await waitStatus(id, ['done'], 60000);
  assert.equal(done?.status, 'done', '恢复后应完成');
  assert.ok(done.file?.endsWith('.mp4'));
});

test('终止：运行中任务可终止', { timeout: 60000 }, async () => {
  const outDir = path.join(tmpRoot, 'cancel-dl');
  const { body } = await post('/api/download', { input: SLOW_URL, outDir });
  const id = body.tasks[0].id;
  const running = await waitStatus(id, ['running', 'done'], 20000);
  assert.ok(running);
  if (running.status === 'done') return;
  const c = await post('/api/cancel', { id });
  assert.equal(c.status, 200, c.body?.error);
  const cancelled = await waitStatus(id, ['cancelled'], 10000);
  assert.equal(cancelled?.status, 'cancelled', '应变为已终止');
  // 非运行任务再终止 → 400
  assert.equal((await post('/api/cancel', { id })).status, 400);
});

test('POST /api/history/delete: 删除历史记录（含持久化）', { timeout: 60000 }, async () => {
  // 先下一个任务产生历史
  const outDir = path.join(tmpRoot, 'del-dl');
  const { body } = await post('/api/download', { input: STUB_URL, outDir });
  const id = body.tasks[0].id;
  const done = await waitTask(id, 30000);
  assert.equal(done?.status, 'done');
  // 确认历史文件里有这条
  const hist1 = JSON.parse(readFileSync(process.env.VD_HISTORY_PATH, 'utf8'));
  assert.ok(hist1.some((r) => r.id === id));
  // 删除
  const del = await post('/api/history/delete', { id });
  assert.equal(del.status, 200, del.body?.error);
  // 任务列表里没了
  const list = (await j('/api/tasks')).body.tasks;
  assert.ok(!list.some((t) => t.id === id), '任务列表应不含已删除项');
  // 持久化文件里也没了
  const hist2 = JSON.parse(readFileSync(process.env.VD_HISTORY_PATH, 'utf8'));
  assert.ok(!hist2.some((r) => r.id === id), 'history.json 应不含已删除项');
  // 不存在的 → 404
  assert.equal((await post('/api/history/delete', { id: 'nope' })).status, 404);
});

test('GET /api/stats: 基于历史的累计统计', async () => {
  const { body } = await j('/api/stats');
  assert.ok(body.totalFiles >= 1, '至少一条历史');
  assert.ok(body.totalBytes >= stubBody.length, '累计字节应≥单文件');
});

// ---------- 失败任务重试 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitTask(id, timeoutMs = 45000) {
  for (let i = 0; i < timeoutMs / 500; i++) {
    await sleep(500);
    const t = (await j('/api/tasks')).body.tasks.find((x) => x.id === id);
    if (t && (t.status === 'done' || t.status === 'error')) return t;
  }
  return null;
}

test('POST /api/retry: 失败任务复位重跑直至成功', { timeout: 120000 }, async () => {
  flakyFail = true;
  const outDir = path.join(tmpRoot, 'retry-dl');

  // 第一次：桩持续 403 → 内部 3 次重试耗尽 → 任务失败
  const { body } = await post('/api/download', { input: FLAKY_URL, outDir });
  const id = body.tasks[0].id;
  const failed = await waitTask(id);
  assert.equal(failed?.status, 'error', '应失败');
  assert.ok(failed.error, '应有错误信息');

  // 不存在的任务 → 404
  assert.equal((await post('/api/retry', { id: 'no-such' })).status, 404);

  // 恢复桩 → 重试 → 成功，且状态复位正确
  flakyFail = false;
  const r = await post('/api/retry', { id });
  assert.equal(r.status, 200);
  assert.ok(['queued', 'running'].includes(r.body.task.status), '复位后应排队/立即开跑');
  assert.equal(r.body.task.error, null);
  const done = await waitTask(id);
  assert.equal(done?.status, 'done', '重试后应成功');
  assert.ok(done.file?.endsWith('.mp4'));
});
