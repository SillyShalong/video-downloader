// GUI 后端：本地 HTTP 服务（仅绑定 127.0.0.1）
//   GET  /            前端页面
//   GET  /api/tasks   任务列表快照
//   GET  /api/events  SSE 实时任务事件流
//   POST /api/parse   从分享口令/文本解析出 URL 与站点
//   POST /api/download 提交下载任务（顺序执行）
//   POST /api/open    用系统默认程序打开文件
//   POST /api/reveal  在资源管理器中定位文件
import http from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { download, DEFAULT_OUT_DIR } from './downloader.mjs';
import { matchSite, extractUrls } from './sites.mjs';
import { loadConfig, saveConfig, isValidProxy } from './config.mjs';
import { loadHistory, appendHistory } from './history.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 前端为 Vite + React + AntD 构建（web/dist），npm run build:web 生成
const DIST_DIR = path.join(__dirname, '..', 'web', 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

/**
 * 构建 explorer.exe 的参数。explorer 只认 /select,"路径" 格式（引号仅包路径）：
 * 路径含空格时若整段参数被引号包裹会解析失败、退化成打开默认视图。
 * （导出供测试校验命令行格式）
 */
export function buildExplorerArgs(p, isDir) {
  const clean = String(p).replace(/"/g, '');
  return isDir ? [`"${clean}"`] : [`/select,"${clean}"`];
}

function readJson(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * @param {object} opts
 *   pickDirectory: async () => string[]  —— 原生目录选择框（Electron 模式注入）；
 *   未提供时前端会退化到自定义目录浏览器弹窗
 */
export function createApp(opts = {}) {
  const { pickDirectory } = opts;
  const tasks = new Map(); // id -> task
  const queue = []; // 待执行的任务 id（顺序执行）
  const clients = new Set(); // 已连接的 SSE 响应对象
  let pumping = false;

  // 启动时回填历史（已完成任务的元数据：原始链接/目标路径等）
  for (const r of loadHistory()) {
    tasks.set(r.id, { ...r, log: r.log || [], stage: '完成', percent: 100 });
  }

  function emitTask(task, { throttle = false } = {}) {
    const now = Date.now();
    if (throttle && now - task._lastEmit < 300) return;
    task._lastEmit = now;
    task.updatedAt = now;
    const data = JSON.stringify({ type: 'task', task: publicTask(task) });
    for (const res of clients) res.write(`data: ${data}\n\n`);
  }

  function publicTask(t) {
    return {
      id: t.id,
      url: t.url,
      site: t.site,
      status: t.status, // queued | running | done | error | paused | cancelled
      percent: t.percent,
      stage: t.stage,
      title: t.title,
      file: t.file,
      error: t.error,
      speed: t.speed ?? null,
      eta: t.eta ?? null,
      downloaded: t.downloaded ?? null,
      totalBytes: t.totalBytes ?? null,
      sizeBytes: t.sizeBytes ?? null,
      log: t.log,
      quality: t.quality,
      audio: t.audio,
      createdAt: t.createdAt,
    };
  }

  let currentRun = null; // { id, abort: AbortController } —— 正在执行的任务（用于暂停/终止）

  async function pump() {
    if (pumping) return;
    pumping = true;
    while (queue.length > 0) {
      const id = queue.shift();
      const t = tasks.get(id);
      if (!t || t.status === 'paused' || t.status === 'cancelled') continue;
      t.status = 'running';
      t.stage = '解析中';
      t.error = null;
      emitTask(t);

      const abort = new AbortController();
      currentRun = { id, abort };
      try {
        const { files } = await download(t.url, {
          outDir: t.outDir,
          quality: t.quality,
          audioOnly: t.audio,
          signal: abort.signal,
          onEvent: (ev) => {
            if (ev.type === 'progress') {
              t.percent = ev.percent >= 0 ? ev.percent : t.percent;
              t.stage = '下载中';
              t.speed = ev.speed ?? null; // 字节/秒
              t.eta = ev.eta ?? null; // 秒
              t.totalBytes = ev.total ?? null;
              t.downloaded =
                ev.downloaded ??
                (ev.total && t.percent > 0 ? Math.round((ev.total * t.percent) / 100) : null);
              emitTask(t, { throttle: true });
            } else if (ev.type === 'title') {
              t.title = ev.title;
              emitTask(t);
            } else if (ev.type === 'merging') {
              t.stage = '合并音视频';
              t.speed = t.eta = null;
              t.log.push(ev.raw);
              emitTask(t);
            } else if (ev.type === 'info') {
              t.stage = ev.raw;
              t.log.push(ev.raw);
              emitTask(t);
            } else if (ev.type === 'file') {
              t.file = ev.file;
              t.title ??= path.basename(ev.file);
              emitTask(t);
            } else if (ev.type === 'log' && ev.raw.startsWith('ERROR')) {
              t.log.push(ev.raw);
              emitTask(t);
            }
          },
        });
        t.status = 'done';
        t.percent = 100;
        t.stage = '完成';
        t.speed = t.eta = null;
        t.file = files[0] ?? t.file;
        if (files[0]) t.log.push(`✔ ${files[0]}`);
        // 完成时记录文件大小（统计用）
        try {
          t.sizeBytes = statSync(t.file).size;
        } catch {}
        emitTask(t);
        // 持久化到下载历史（失败不影响任务本身）
        try {
          appendHistory({ ...publicTask(t), log: (t.log || []).slice(-10) });
        } catch {}
      } catch (err) {
        if (abort.signal.aborted) {
          // 用户主动暂停/终止：保留 .part 供恢复（yt-dlp 断点续传）
          t.status = t._intent || 'cancelled';
          t.stage = t.status === 'paused' ? '已暂停' : '已终止';
          t.speed = t.eta = null;
          t.log.push(t.status === 'paused' ? '⏸ 已暂停（恢复时断点续传）' : '⏹ 已终止');
        } else {
          t.status = 'error';
          t.error = err.message.split('\n').slice(-6).join('\n');
          t.log.push(`✖ ${err.message}`);
        }
        emitTask(t);
      } finally {
        currentRun = null;
      }
    }
    pumping = false;
  }

  function createTasks(input, { quality, audio, outDir }) {
    const text = String(input || '').trim();
    let urls = extractUrls(text);
    if (urls.length === 0 && /^https?:\/\//i.test(text)) urls = [text];
    urls = [...new Set(urls)].slice(0, 10);
    if (urls.length === 0) throw new Error('未在输入中找到链接');
    const created = [];
    for (const url of urls) {
      const task = {
        id: randomUUID().slice(0, 8),
        url,
        site: matchSite(url)?.id ?? 'generic',
        status: 'queued',
        percent: 0,
        stage: '排队中',
        title: null,
        file: null,
        error: null,
        speed: null,
        eta: null,
        downloaded: null,
        totalBytes: null,
        sizeBytes: null,
        log: [],
        outDir: path.resolve(outDir || DEFAULT_OUT_DIR),
        quality: quality || null,
        audio: !!audio,
        createdAt: Date.now(),
      };
      tasks.set(task.id, task);
      queue.push(task.id);
      created.push(task);
    }
    pump(); // 异步跑，不等
    return created;
  }

  // 驱动器列表（Windows，PowerShell 查询一次后缓存）
  let drivesCache = null;
  function listDrives() {
    if (drivesCache) return drivesCache;
    try {
      const r = spawnSync(
        'powershell',
        ['-NoProfile', '-Command', '(Get-PSDrive -PSProvider FileSystem).Root'],
        { encoding: 'utf8', windowsHide: true, timeout: 8000 },
      );
      drivesCache = (r.stdout || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => /^[A-Z]:\\?$/i.test(s));
    } catch {}
    if (!drivesCache || drivesCache.length === 0) drivesCache = ['C:\\'];
    return drivesCache;
  }

  const server = http.createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };

    try {
      // 静态资源（Vite 构建产物，非 /api 一律走这里；SPA 回退到 index.html）
      if (req.method === 'GET' && !req.url.startsWith('/api')) {
        const idx = path.join(DIST_DIR, 'index.html');
        if (!existsSync(idx)) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('前端未构建：请先运行 npm run build:web');
          return;
        }
        const u = new URL(req.url, 'http://localhost');
        let fp = path.normalize(path.join(DIST_DIR, decodeURIComponent(u.pathname)));
        if (!fp.toLowerCase().startsWith(DIST_DIR.toLowerCase())) {
          res.writeHead(403);
          res.end('forbidden');
          return;
        }
        if (!existsSync(fp) || statSync(fp).isDirectory()) fp = idx;
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
        res.end(await readFile(fp));
        return;
      }

      if (req.method === 'GET' && req.url === '/api/tasks') {
        send(200, { tasks: [...tasks.values()].map(publicTask).sort((a, b) => b.createdAt - a.createdAt) });
        return;
      }

      if (req.method === 'GET' && req.url === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write('retry: 2000\n\n');
        res.write(`data: ${JSON.stringify({ type: 'init', tasks: [...tasks.values()].map(publicTask).sort((a, b) => b.createdAt - a.createdAt) })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      if (req.method === 'POST' && req.url === '/api/parse') {
        const body = await readJson(req);
        const text = String(body.input || '').trim();
        let urls = extractUrls(text);
        if (urls.length === 0 && /^https?:\/\//i.test(text)) urls = [text];
        send(200, {
          urls: [...new Set(urls)].map((url) => ({ url, site: matchSite(url)?.id ?? 'generic' })),
        });
        return;
      }

      if (req.method === 'POST' && req.url === '/api/download') {
        const body = await readJson(req);
        if (body.quality && !/^\d{3,4}$/.test(body.quality)) {
          send(400, { error: '无效的清晰度' });
          return;
        }
        const created = createTasks(body.input, body);
        send(200, { tasks: created.map(publicTask) });
        return;
      }

      if (req.method === 'GET' && req.url === '/api/config') {
        send(200, loadConfig());
        return;
      }

      if (req.method === 'POST' && req.url === '/api/config') {
        const body = await readJson(req);
        const patch = {};
        if (body.proxy !== undefined) {
          const proxy = String(body.proxy ?? '').trim();
          if (!isValidProxy(proxy)) {
            send(400, { error: '代理地址无效，应形如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080' });
            return;
          }
          patch.proxy = proxy;
        }
        if (body.bilibiliSessdata !== undefined) {
          const sessdata = String(body.bilibiliSessdata ?? '').trim();
          if (sessdata && !/^[A-Za-z0-9%*,\-_.]+$/.test(sessdata)) {
            send(400, { error: 'SESSDATA 格式不正确（应为浏览器 Cookie 里的纯值，不含引号或 Cookie: 前缀）' });
            return;
          }
          patch.bilibiliSessdata = sessdata;
        }
        saveConfig(patch);
        send(200, { ok: true, ...patch });
        return;
      }

      if (req.method === 'POST' && req.url === '/api/proxy-test') {
        const body = await readJson(req);
        const proxy = String(body.proxy ?? '').trim();
        if (!isValidProxy(proxy) || !proxy) {
          send(400, { error: '代理地址无效' });
          return;
        }
        const t0 = Date.now();
        const result = await new Promise((resolve) => {
          const child = spawn(
            'curl',
            ['-x', proxy, '-s', '-o', 'NUL', '-w', '%{http_code}', '--connect-timeout', '6', '-m', '10', 'https://www.youtube.com/'],
            { windowsHide: true },
          );
          let out = '';
          child.stdout.on('data', (c) => (out += c));
          child.on('error', () => resolve({ ok: false, message: '无法启动 curl' }));
          child.on('close', (code) => {
            const httpCode = out.trim();
            resolve({
              ok: code === 0 && /^[23]/.test(httpCode),
              message: code === 0 ? `HTTP ${httpCode}` : code === 28 ? '连接超时' : `连接失败（退出码 ${code}）`,
            });
          });
        });
        send(200, { ...result, ms: Date.now() - t0 });
        return;
      }

      if (req.method === 'POST' && req.url === '/api/pick-dir') {
        if (pickDirectory) {
          const paths = await pickDirectory();
          send(200, { native: true, path: paths?.[0] ?? null }); // 取消时为 null
        } else {
          send(200, { native: false }); // 前端退化到自定义目录浏览器
        }
        return;
      }

      if (req.method === 'GET' && req.url.startsWith('/api/fs/list')) {
        const q = new URL(req.url, 'http://localhost').searchParams;
        const dir = (q.get('dir') || '').trim();
        const home = os.homedir();
        if (!dir) {
          // 根视图：主目录 + 所有驱动器
          send(200, {
            path: null,
            parent: null,
            home,
            entries: [{ name: '主目录', path: home }, ...listDrives().map((d) => ({ name: d, path: d }))],
          });
          return;
        }
        let entries = [];
        let err = null;
        try {
          const items = await readdir(dir, { withFileTypes: true });
          entries = items
            .filter(
              (it) =>
                it.isDirectory() &&
                !it.name.startsWith('$') && // $Recycle.Bin 等系统目录
                it.name !== 'System Volume Information',
            )
            .map((it) => ({ name: it.name, path: path.join(dir, it.name) }))
            .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
        } catch (e) {
          err = e.code === 'EPERM' || e.code === 'EACCES' ? '无权访问该目录' : `无法读取: ${e.message}`;
        }
        const parent = path.dirname(dir) === dir ? null : path.dirname(dir);
        send(200, { path: dir, parent, home, entries, err });
        return;
      }

      if (req.method === 'POST' && req.url === '/api/pause') {
        const body = await readJson(req);
        const t = tasks.get(String(body.id || ''));
        if (!t) {
          send(404, { error: '任务不存在' });
          return;
        }
        if (t.status === 'queued') {
          // 排队中：直接出队标记
          const i = queue.indexOf(t.id);
          if (i >= 0) queue.splice(i, 1);
          t.status = 'paused';
          t.stage = '已暂停';
          emitTask(t);
          send(200, { ok: true });
          return;
        }
        if (t.status !== 'running' || currentRun?.id !== t.id) {
          send(400, { error: '任务不在下载中，无法暂停' });
          return;
        }
        t._intent = 'paused';
        currentRun.abort.abort();
        send(200, { ok: true });
        return;
      }

      if (req.method === 'POST' && req.url === '/api/cancel') {
        const body = await readJson(req);
        const t = tasks.get(String(body.id || ''));
        if (!t) {
          send(404, { error: '任务不存在' });
          return;
        }
        if (t.status === 'queued') {
          const i = queue.indexOf(t.id);
          if (i >= 0) queue.splice(i, 1);
          t.status = 'cancelled';
          t.stage = '已终止';
          emitTask(t);
          send(200, { ok: true });
          return;
        }
        if (t.status !== 'running' || currentRun?.id !== t.id) {
          send(400, { error: '任务不在下载中，无法终止' });
          return;
        }
        t._intent = 'cancelled';
        currentRun.abort.abort();
        send(200, { ok: true });
        return;
      }

      if (req.method === 'GET' && req.url === '/api/stats') {
        const hist = loadHistory();
        const totalBytes = hist.reduce((s, r) => s + (r.sizeBytes || 0), 0);
        send(200, { totalFiles: hist.length, totalBytes });
        return;
      }

      if (req.method === 'POST' && req.url === '/api/retry') {
        const body = await readJson(req);
        const t = tasks.get(String(body.id || ''));
        if (!t) {
          send(404, { error: '任务不存在' });
          return;
        }
        if (t.status === 'running' || t.status === 'queued') {
          send(400, { error: '任务进行中，无法重试' });
          return;
        }
        // 复位任务重新入队；createdAt 更新让任务卡回到列表顶部
        Object.assign(t, {
          status: 'queued',
          percent: 0,
          stage: t.status === 'paused' ? '恢复中…' : '排队中',
          error: null,
          log: [],
          file: null,
          speed: null,
          eta: null,
          downloaded: null,
          totalBytes: null,
          createdAt: Date.now(),
        });
        delete t._intent;
        queue.push(t.id);
        emitTask(t);
        pump(); // 异步跑，不等
        send(200, { ok: true, task: publicTask(t) });
        return;
      }

      if (req.method === 'POST' && req.url === '/api/open') {
        // 用系统默认程序打开文件（播放器/图片查看器等）
        const body = await readJson(req);
        const p = String(body.path || '').replace(/"/g, '');
        if (!p || !existsSync(p)) {
          send(404, { error: '文件不存在（可能已被移动或删除）' });
          return;
        }
        if (statSync(p).isDirectory()) {
          send(400, { error: '这是目录，请用「打开文件夹」' });
          return;
        }
        // cmd /c start "" "路径"：start 首个引号参数是窗口标题占位，
        // 空标题 + 引号包裹路径可正确处理空格/中文/emoji
        spawn('cmd', ['/c', 'start', '', p], { detached: true, stdio: 'ignore' }).unref();
        send(200, { ok: true });
        return;
      }

      if (req.method === 'POST' && req.url === '/api/reveal') {
        const body = await readJson(req);
        const p = String(body.path || '').replace(/"/g, '');
        if (!p || !existsSync(p)) {
          send(404, { error: '文件不存在' });
          return;
        }
        const isDir = statSync(p).isDirectory();
        const [arg] = buildExplorerArgs(p, isDir);
        spawn('explorer.exe', [arg], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
        send(200, { ok: true });
        return;
      }

      res.writeHead(404);
      res.end('not found');
    } catch (err) {
      send(500, { error: err.message });
    }
  });

  return server;
}
