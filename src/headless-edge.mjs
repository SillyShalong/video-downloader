// 无头 Edge 控制模块（CDP 协议，零依赖：Node 22+ 自带全局 WebSocket）
// 用途：打开真实浏览器让页面自己的 JS 执行（生成签名/风控 cookie），再在页面上下文里调用 API。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const NORMAL_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findEdge() {
  return EDGE_CANDIDATES.find((p) => p && existsSync(p)) ?? null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** 极简 CDP 客户端：命令收发 */
function createCdp(wsUrl) {
  let nextId = 1;
  const pending = new Map();
  const ws = new WebSocket(wsUrl);
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`CDP: ${msg.error.message}`));
      else resolve(msg.result);
    }
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return {
    opened,
    send(method, params = {}, sessionId) {
      const id = nextId++;
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      const reply = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      ws.send(JSON.stringify(msg));
      return reply;
    },
    close: () => ws.close(),
  };
}

/**
 * 启动无头 Edge 打开 url，等页面加载后把 {cdp, sessionId} 交给 fn，
 * 返回 fn 的结果。结束后自动关闭浏览器并清理临时 profile。
 * @param {string} url
 * @param {(ctx: {cdp: object, sessionId: string}) => Promise<any>} fn
 * @param {object} opts { settleMs: loadEventFired 后额外等待毫秒 }
 */
export async function withPage(url, fn, { settleMs = 4000 } = {}) {
  const edge = findEdge();
  if (!edge) throw new Error('未找到 msedge.exe，可设置环境变量 EDGE_PATH 指定路径');

  const port = await freePort();
  const profile = mkdtempSync(path.join(tmpdir(), 'vd-edge-'));
  const child = spawn(
    edge,
    [
      '--headless=new',
      '--disable-gpu',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--user-agent=${NORMAL_UA}`,
      'about:blank',
    ],
    { windowsHide: true, stdio: 'ignore' },
  );

  let cdp;
  try {
    let version;
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        version = await res.json();
        break;
      } catch {
        await sleep(250);
      }
    }
    if (!version) throw new Error('Edge 调试端口未就绪');

    cdp = createCdp(version.webSocketDebuggerUrl);
    await cdp.opened;

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url }, sessionId);
    // 轮询 readyState 等待页面加载完成
    for (let i = 0; i < 60; i++) {
      const st = await cdp
        .send('Runtime.evaluate', { expression: 'document.readyState' }, sessionId)
        .then((r) => r.result?.value)
        .catch(() => null);
      if (st === 'complete') break;
      await sleep(500);
    }
    await sleep(settleMs); // 给页面 JS（风控 SDK 等）时间初始化

    return await fn({ cdp, sessionId });
  } finally {
    try {
      if (cdp) {
        await cdp.send('Browser.close').catch(() => {});
        cdp.close();
      }
    } catch {}
    try {
      child.kill();
    } catch {}
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 5000);
      child.once('exit', () => {
        clearTimeout(t);
        setTimeout(resolve, 300);
      });
    });
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    } catch {
      // 清不掉就算了，留个临时目录不致命
    }
  }
}

/** 在页面上下文执行异步 JS，返回值需可 JSON 序列化 */
export async function evalInPage(cdp, sessionId, expression) {
  const r = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (r.exceptionDetails) {
    throw new Error(`页面执行出错: ${r.exceptionDetails.text}`);
  }
  return r.result?.value;
}
