// GUI 后端：本地 HTTP 服务（仅绑定 127.0.0.1）
//   GET  /            前端页面
//   GET  /api/tasks   任务列表快照
//   GET  /api/events  SSE 实时任务事件流
//   POST /api/parse   从分享口令/文本解析出 URL 与站点
//   POST /api/download 提交下载任务（顺序执行）
//   POST /api/open    用系统默认程序打开文件
//   POST /api/reveal  在资源管理器中定位文件
import http from 'node:http';
import { existsSync, statSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { download, downloadRoute, inspectUrl, DEFAULT_OUT_DIR } from './downloader.mjs';
import { summarizeSources } from './stream-source.mjs';
import { matchSite, extractUrls } from './sites.mjs';
import { loadConfig, saveConfig, isValidProxy, normalizeHlsSites } from './config.mjs';
import { loadHistory, appendHistory, removeHistory } from './history.mjs';
import { openCommand, revealCommand, listRoots } from './platform.mjs';

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
 * Windows 下构建 explorer.exe 的参数（导出供测试校验命令行格式）。
 * 跨平台行为见 src/platform.mjs 的 revealCommand/openCommand。
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
  const queue = []; // 待执行的任务 id（按先后顺序领，同时最多跑 maxParallel 个）
  const clients = new Set(); // 已连接的 SSE 响应对象
  let pumping = false;
  /** 正在下载的任务 → { abort, done }（done 在任务结束时兑现） */
  const running = new Map();

  const ACTIVE_FILE = path.join(path.dirname(process.env.VD_HISTORY_PATH || path.join(__dirname, '..', 'history.json')), 'active-tasks.json');

  // ---- 重启续传：读取上次未完成任务并重新入队（yt-dlp 从 .part 断点续传） ----
  function restoreActiveTasks() {
    try {
      const raw = readFileSync(ACTIVE_FILE, 'utf8');
      const arr = JSON.parse(raw);
      for (const saved of arr) {
        // 不与已有历史重复
        if (tasks.has(saved.id)) continue;
        const t = { ...saved, status: 'queued', stage: '恢复中…', percent: 0, speed: null, eta: null, log: ['↻ 检测到未完成任务，自动恢复（断点续传）'] };
        tasks.set(t.id, t);
        queue.push(t.id);
      }
      if (arr.length > 0) console.log(`恢复 ${arr.length} 个未完成任务`);
    } catch {}
  }

  /** 保存当前 running/paused 任务到文件（退出前调用） */
  function saveActiveTasks() {
    try {
      const active = [...tasks.values()]
        .filter((t) => t.status === 'running' || t.status === 'paused' || t.status === 'queued')
        .map((t) => ({ id: t.id, url: t.url, site: t.site, quality: t.quality, audio: t.audio, outDir: t.outDir, playlistItems: t.playlistItems, title: t.title, createdAt: t.createdAt }));
      writeFileSync(ACTIVE_FILE, JSON.stringify(active, null, 2), 'utf8');
    } catch {}
  }

  /** 任务在目标目录里的临时下载目录：没下完的 .part 放在这里（按任务 id 命名，恢复时能接着用） */
  const removeWorkDir = (t) => {
    try {
      rmSync(path.join(t.outDir, `.vd-tmp-${t.id}`), { recursive: true, force: true });
    } catch {}
  };

  // 启动时回填历史（已完成任务的元数据）
  for (const r of loadHistory()) {
    tasks.set(r.id, { ...r, log: r.log || [], stage: '完成', percent: 100 });
  }

  // 恢复上次未完成的任务
  restoreActiveTasks();
  // 恢复任务后启动下载队列（pump 函数声明提升，此处可调用）
  setTimeout(() => pump(), 500);

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
      // 真正的视频流地址（域名 + 解析出的 IP）；没取到时为 null
      sources: t.sources ?? null,
      sourceProxy: t.sourceProxy ?? null,
      // 数据走的是设置里的代理还是直连（任务开始运行时定下来）；老记录没有这个字段
      route: t.route ?? null,
      quality: t.quality,
      audio: t.audio,
      playlistItems: t.playlistItems ?? null,
      createdAt: t.createdAt,
    };
  }


  /** 同时下载的任务数（config.json 的 maxParallel，默认 3 个） */
  function maxParallel() {
    const n = Number(loadConfig().maxParallel);
    return Number.isInteger(n) && n >= 1 && n <= 8 ? n : 3;
  }

  /**
   * 从队列里领任务：直到队列空了，或者同时在跑的任务数到了上限。
   * 领任务只会有一个循环在做（pumping），所以不会有两个循环领到同一个任务。
   */
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length > 0) {
        if (running.size >= maxParallel()) {
          // 到上限了：等任何一个在跑的任务结束再接着领
          await Promise.race([...running.values()].map((r) => r.done));
          continue;
        }
        const id = queue.shift();
        const t = tasks.get(id);
        if (!t || t.status === 'paused' || t.status === 'cancelled') continue;
        runTask(t); // 不等它跑完，接着看还能不能再领一个
      }
    } finally {
      pumping = false;
    }
  }

  /** 跑一个任务。同一时刻可能有多个任务在跑，各自的状态只在自己的闭包里改 */
  async function runTask(t) {
    const id = t.id;
    const abort = new AbortController();
    let finish = () => {};
    const done = new Promise((resolve) => (finish = resolve));
    running.set(id, { abort, done });
    try {
      t.status = 'running';
      t.stage = '解析中';
      t.error = null;
      t.route = downloadRoute(t.url); // 走代理还是直连：一开始就定下来，界面据此标「走代理 / 直连」
      emitTask(t);

      try {
        const { files } = await download(t.url, {
          outDir: t.outDir,
          taskId: id, // 下载器用它给这个任务单独建一个临时目录
          quality: t.quality,
          audioOnly: t.audio,
          playlistItems: t.playlistItems,
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
              // 实时日志：最新进度行滚动替换（≥1.2s 一条），避免日志刷屏但保持实时感
              if (ev.raw && Date.now() - (t._lastLogTs || 0) > 1200) {
                t._lastLogTs = Date.now();
                const lastLog = t.log[t.log.length - 1];
                if (lastLog && lastLog.startsWith('[download]')) t.log[t.log.length - 1] = ev.raw;
                else t.log.push(ev.raw);
              }
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
            } else if (ev.type === 'source') {
              // 真正的视频流地址（域名 + 解析出的 IP）：详情里单独一块显示，日志里也留一行。
              // 同一组来源会来两次（先带域名、IP 解析完再来一次）：第二次原地更新那一行，不追加
              t.sources = ev.streams;
              t.sourceProxy = ev.proxy;
              const line = `[source] ${summarizeSources(ev)}`;
              if (t._sourceId === ev.sourceId) t.log[t._sourceLine] = line;
              else {
                t._sourceId = ev.sourceId;
                t._sourceLine = t.log.push(line) - 1;
              }
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
          // 终止：连没下完的临时文件一起删掉；暂停：留着供续传
          if (t.status !== 'paused') removeWorkDir(t);
        } else {
          t.status = 'error';
          t.error = err.message.split('\n').slice(-6).join('\n');
          t.log.push(`✖ ${err.message}`);
        }
        emitTask(t);
      }
    } finally {
      running.delete(id);
      finish();
      pump(); // 腾出了名额：队列里还有任务的话接着领
    }
  }
  function createTasks(input, { quality, audio, outDir, playlistItems }) {
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
        playlistItems: Array.isArray(playlistItems) && playlistItems.length > 0 ? playlistItems : null,
        createdAt: Date.now(),
      };
      tasks.set(task.id, task);
      queue.push(task.id);
      created.push(task);
    }
    pump(); // 异步跑，不等
    return created;
  }

  const server = http.createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };

    // CORS：远程模式（手机 App / PWA）跨域访问桌面服务所必需
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

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

      if (req.method === 'POST' && req.url === '/api/inspect') {
        const body = await readJson(req);
        const text = String(body.input || '').trim();
        let urls = extractUrls(text);
        if (urls.length === 0 && /^https?:\/\//i.test(text)) urls = [text];
        if (urls.length === 0) {
          send(400, { error: '未在输入中找到链接' });
          return;
        }
        // 仅探测第一条（多 URL 由用户自行分次提交）
        try {
          const r = await inspectUrl(urls[0]);
          send(200, r);
        } catch (err) {
          send(200, { multi: false, entries: [], error: err.message.split('\n').slice(-2).join('\n') });
        }
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
        if (body.hlsSites !== undefined) {
          patch.hlsSites = normalizeHlsSites(body.hlsSites);
        }
        if (body.maxParallel !== undefined) {
          const n = Number(body.maxParallel);
          if (!Number.isInteger(n) || n < 1 || n > 8) {
            send(400, { error: '同时下载任务数应为 1 到 8 的整数' });
            return;
          }
          patch.maxParallel = n;
        }
        saveConfig(patch);
        // 调大了名额：队列里等着的任务可以接着领
        pump();
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
            entries: listRoots(),
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
        if (t.status !== 'running' || !running.has(t.id)) {
          send(400, { error: '任务不在下载中，无法暂停' });
          return;
        }
        t._intent = 'paused';
        running.get(t.id).abort.abort();
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
        if (t.status !== 'running' || !running.has(t.id)) {
          send(400, { error: '任务不在下载中，无法终止' });
          return;
        }
        t._intent = 'cancelled';
        running.get(t.id).abort.abort();
        send(200, { ok: true });
        return;
      }

      if (req.method === 'GET' && req.url === '/api/stats') {
        const hist = loadHistory();
        const totalBytes = hist.reduce((s, r) => s + (r.sizeBytes || 0), 0);
        send(200, { totalFiles: hist.length, totalBytes });
        return;
      }

      if (req.method === 'POST' && req.url === '/api/history/delete') {
        const body = await readJson(req);
        const id = String(body.id || '');
        const t = tasks.get(id);
        if (!t) {
          send(404, { error: '任务不存在' });
          return;
        }
        if (t.status === 'running' || t.status === 'queued') {
          send(400, { error: '任务进行中，请先终止' });
          return;
        }
        tasks.delete(id);
        removeWorkDir(t); // 可能还留着没下完的临时文件
        try { removeHistory(id); } catch {}
        // 广播删除事件（前端收到后从列表移除）
        const data = JSON.stringify({ type: 'delete', id });
        for (const res of clients) res.write(`data: ${data}\n\n`);
        send(200, { ok: true });
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
        // 用系统默认程序打开文件（播放器/图片查看器等）——平台差异见 platform.mjs
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
        const c = openCommand(p);
        spawn(c.file, c.args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: c.verbatim }).unref();
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
        const c = revealCommand(p, isDir);
        spawn(c.file, c.args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: c.verbatim }).unref();
        send(200, { ok: true });
        return;
      }

      res.writeHead(404);
      res.end('not found');
    } catch (err) {
      send(500, { error: err.message });
    }
  });

  server.saveActiveTasks = saveActiveTasks;
  return server;
}
