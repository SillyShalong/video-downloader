#!/usr/bin/env node
// 安卓 App 真实界面 E2E（需要：已启动的模拟器 + 已安装 debug APK + adb）
//
//   node tests/android-e2e.mjs                 跑全部
//   node tests/android-e2e.mjs --only=bili,yt  只跑指定用例
//   node tests/android-e2e.mjs --list          列出用例
//
// adb 的位置：环境变量 ADB，或 ANDROID_HOME / ANDROID_SDK_ROOT 下的 platform-tools，或 PATH。
// 涉及 YouTube / B站 的用例需要模拟器能访问外网；HLS 用例用的是电脑上起的本地测试源（10.0.2.2）。
//
// 与 curl 调接口不同：这里的每一步都是真实用户路径——
//   · 点击/输入用 `adb shell input tap|text`（系统输入事件 → WebView → 页面）
//     每次点击前后都核对目标：点之前确认坐标上就是目标元素，点之后确认点击事件确实落在它身上
//   · 断言读的是页面上真实渲染出来的 DOM
//   · 系统界面（目录选择器等）用 uiautomator 找控件后真实点击
// 同时通过 WebView DevTools 协议收集控制台错误与每个网络请求的结果。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FFMPEG, assertAVSync, assertPlayable, assertSameAudio, assertSameVideo, decodeErrors, probeText } from './media-tools.mjs';
import { startHlsServer } from './android-hls-server.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// adb：优先用环境变量 ADB，其次 Android SDK 里的（ANDROID_SDK_ROOT / ANDROID_HOME），最后找 PATH
const SDK = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
const ADB =
  process.env.ADB ||
  (SDK ? path.join(SDK, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb') : 'adb');
const YTDLP = process.env.YTDLP || path.join(REPO, 'bin', 'yt-dlp.exe'); // 电脑端取参考流用
const PKG = 'com.sillyshalong.videodownloader';
const APP_LABEL = 'Video Downloader'; // 应用名（系统「无响应」提示的标题里会带它）
const ACTIVITY = `${PKG}/.MainActivity`;
const API_PORT = 18977; // 宿主端口 → 设备 8977
const DEVTOOLS_PORT = 9333;
/** 截图 / 拉回来的文件等产物的存放目录（测试失败时留证据用） */
export const ARTIFACTS = process.env.VD_E2E_ARTIFACTS || path.join(tmpdir(), 'vd-e2e-artifacts');
const DEFAULT_DIR = '/sdcard/Download/VideoDownloader'; // App 的默认下载目录
const PICK_FOLDER = 'VD_E2E'; // 「选择目录」用例使用的文件夹（第一次运行时在系统选择器里新建）
const PICK_DIR = `/sdcard/Download/${PICK_FOLDER}`;
const DOCS = 'com.google.android.documentsui'; // 系统文件选择器

const argv = process.argv.slice(2);
const only = (argv.find((a) => a.startsWith('--only='))?.slice(7) || '').split(',').filter(Boolean);

/* ---------------------------------------------------------------- adb -- */
export function adb(args, { binary = false, allowFail = false, timeout = 90000 } = {}) {
  const r = spawnSync(ADB, args, {
    encoding: binary ? 'buffer' : 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error) {
    throw new Error(
      `无法运行 adb（${ADB}）：${r.error.message}\n  需要 Android SDK 的 platform-tools：设置 ANDROID_HOME（或 ANDROID_SDK_ROOT / ADB 环境变量），或把 adb 加进 PATH`,
    );
  }
  if (r.status !== 0 && !allowFail) {
    throw new Error(`adb ${args.join(' ')} ${r.signal ? `被中止（${r.signal}${r.signal === 'SIGTERM' ? '，超时' : ''}）` : `退出码 ${r.status}`}: ${r.stderr}`);
  }
  return r.stdout;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(desc, fn, { timeout = 15000, interval = 250, onFail } = {}) {
  const t0 = Date.now();
  let lastErr;
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(interval);
  }
  const e = new Error(`等待超时(${timeout}ms): ${desc}${lastErr ? `，最后错误: ${lastErr.message}` : ''}`);
  if (onFail) await onFail(e).catch(() => {});
  throw e;
}

/* -------------------------------------------------------------- DevTools -- */
/**
 * 注入页面的探针（页面加载时 + 连接当下各执行一次）：
 *  - window.__sse：页面创建的每一个 EventSource，用来诊断「界面没更新」是不是事件流断了
 *  - window.__clicks / __clickTargets：每一次点击的坐标、点击者描述和目标元素，
 *    用来核对系统下发的点击有没有落在想点的元素上
 */
const PAGE_INSTRUMENTATION = `(() => {
  if (!window.__sse) {
    window.__sse = [];
    const Orig = window.EventSource;
    window.EventSource = class extends Orig { constructor(...a) { super(...a); window.__sse.push(this); } };
  }
  if (!window.__clicks) {
    window.__clicks = [];
    window.__clickTargets = [];
    const describe = (n) => {
      const el = n instanceof Element ? n : null;
      if (!el) return String(n);
      const name = el.id ? '#' + el.id : el.tagName.toLowerCase() + [...el.classList].slice(0, 2).map((c) => '.' + c).join('');
      const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 16);
      return name + (text ? '(' + text + ')' : '');
    };
    for (const type of ['pointerdown', 'click']) {
      document.addEventListener(type, (e) => {
        window.__clicks.push({ type, x: Math.round(e.clientX), y: Math.round(e.clientY), scrollY: Math.round(scrollY), innerHeight, at: Math.round(performance.now()), target: describe(e.target) });
        window.__clickTargets.push(e.target);
      }, true);
    }
  }
})();`;

export async function connect() {
  const pid = adb(['shell', 'pidof', PKG]).trim();
  assert.match(pid, /^\d+$/, 'App 进程应在运行');
  adb(['forward', `tcp:${DEVTOOLS_PORT}`, `localabstract:webview_devtools_remote_${pid}`]);
  adb(['forward', `tcp:${API_PORT}`, 'tcp:8977']);

  const list = JSON.parse(await (await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json`)).text());
  const page = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:8977'));
  assert.ok(page, '应找到 App 页面，实际: ' + JSON.stringify(list.map((t) => t.url)));

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('DevTools WebSocket 连接失败')), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const net = { requests: [], all: [], reset() { this.requests = []; } };
  const console_ = { errors: [], reset() { this.errors = []; } };

  let closed = false;
  ws.addEventListener('close', () => {
    closed = true;
    for (const p of pending.values()) p.reject(new Error('DevTools 连接已断开（App 被重启或页面崩溃）'));
    pending.clear();
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(`CDP ${m.error.message}`));
      else p.resolve(m.result);
      return;
    }
    switch (m.method) {
      case 'Runtime.consoleAPICalled':
        if (m.params.type === 'error') {
          console_.errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
        }
        break;
      case 'Runtime.exceptionThrown':
        console_.errors.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300));
        break;
      case 'Network.requestWillBeSent':
        net.requests.push({ id: m.params.requestId, url: m.params.request.url, method: m.params.request.method });
        net.all.push(net.requests[net.requests.length - 1]);
        break;
      case 'Network.responseReceived': {
        const r = net.requests.find((x) => x.id === m.params.requestId);
        if (r) r.status = m.params.response.status;
        break;
      }
      case 'Network.loadingFailed': {
        const r = net.requests.find((x) => x.id === m.params.requestId);
        if (r) r.failed = m.params.errorText;
        break;
      }
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (closed) {
        // 连接已断：立即失败，绝不静默挂起
        reject(new Error(`DevTools 连接已关闭，无法执行 ${method}（App 被重启后请重新 connect）`));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  // 跟踪页面创建的每一个 EventSource（实时任务事件流），用来诊断「界面没更新」是不是事件流断了
  await send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_INSTRUMENTATION });

  /** 页面里 EventSource 的状态：[地址, readyState(0=连接中 1=已连接 2=已断开)] */
  const sseState = () => evaluate('window.__sse.map((e) => [e.url.split("/api/")[1] || e.url, e.readyState])');

  /** 在页面里执行表达式（支持 Promise），返回可序列化结果 */
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error('页面执行出错: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  };

  await evaluate(PAGE_INSTRUMENTATION); // addScriptToEvaluateOnNewDocument 只对之后加载的页面生效，当前页面补注入一次

  const clickCount = () => evaluate('window.__clicks.length');
  const clickLog = (from) => evaluate(`window.__clicks.slice(${from})`);
  /** 从 [from] 起，是否有一次点击落在选择器匹配的元素（或它的子元素）上 */
  const clickLanded = (selector, from) => evaluate(`window.__clickTargets.slice(${from}).some((el) => el && el.closest(${JSON.stringify(selector)}))`);

  /**
   * WebView 在屏幕上的位置（点击坐标换算用）：{screenX, screenY, width, height}。
   * DevTools 的 page.description 在页面刚创建、WebView 还没挂到窗口上时全是 0 —— 拿 0 去换算，
   * 点击会整体偏上半个状态栏（看着像点到了别的控件）。所以它没给全时，改从系统的无障碍树里读 WebView 的边界。
   */
  const webViewRect = async () => {
    const d = JSON.parse(page.description);
    if (d.width > 0 && d.height > 0) return d;
    const n = uiFind((x) => x.class === 'android.webkit.WebView' && x.package === PKG);
    if (!n || n.x2 <= n.x1 || n.y2 <= n.y1) return false;
    return { screenX: n.x1, screenY: n.y1, width: n.x2 - n.x1, height: n.y2 - n.y1 };
  };
  const screen = await waitFor('拿到 WebView 在屏幕上的位置', webViewRect, { timeout: 20000, interval: 500 });
  const dpr = await evaluate('window.devicePixelRatio');

  let tokens = 0;

  /** 取元素中心的 CSS 坐标（会先滚动到可视区）；sel 用来在点击前后核对「点的是不是它」 */
  const rectOf = async (selector) => {
    const r = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
    })()`);
    return r && { ...r, sel: selector };
  };

  /** 按文本找可点击元素（按钮/标签等）并返回中心坐标 */
  const rectByText = async (text, tag = '*') => {
    const token = `e2e${++tokens}`;
    const r = await evaluate(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(tag)})].filter(
        (el) => el.children.length <= 3 && el.textContent.trim().replace(/\\s+/g, '') === ${JSON.stringify(text.replace(/\s+/g, ''))},
      );
      const el = els.find((e) => e.offsetParent !== null);
      if (!el) return null;
      el.setAttribute('data-e2e', ${JSON.stringify(token)});
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
    })()`);
    return r && { ...r, sel: `[data-e2e="${token}"]` };
  };

  /** 等元素位置稳定下来（抽屉、弹窗有滑入动画，动画没结束就点会落空）再返回它的位置 */
  const stableRect = async (getRect) => {
    let last = null;
    for (let i = 0; i < 25; i++) {
      const r = await getRect();
      if (r && last && Math.abs(r.x - last.x) < 1 && Math.abs(r.y - last.y) < 1 && Math.abs(r.w - last.w) < 1) return r;
      last = r;
      await sleep(120);
    }
    return last;
  };

  /** 坐标上是不是目标元素（测量之后页面可能又变了：键盘动画、异步渲染都会挪动元素） */
  const isOnTarget = (rect) =>
    evaluate(`(() => { const el = document.elementFromPoint(${rect.x}, ${rect.y}); return !!el && !!el.closest(${JSON.stringify(rect.sel)}); })()`);

  /** 点击记录：失败时用来还原「想点什么、实际点了哪里」 */
  const taps = [];

  /**
   * 真实点击：把 CSS 坐标换算成屏幕物理坐标，经系统输入事件下发。
   * 量到位置后先确认坐标上就是目标再点，点完再核对点击确实落在它身上；
   * 点击被系统吃掉（没收到任何点击事件）就重新量、重新点。
   */
  const clickAt = async (getRect, label) => {
    for (let attempt = 1; ; attempt++) {
      const rect = await stableRect(getRect);
      if (!rect) throw new Error(`点击失败：页面上找不到 ${label}`);
      if (!(await isOnTarget(rect))) {
        if (attempt >= 5) throw new Error(`点击失败：等了 5 次，${label} 的位置始终被别的元素占着`);
        await sleep(150);
        continue;
      }
      const x = Math.round(rect.x * dpr) + (screen.screenX || 0);
      const y = Math.round(rect.y * dpr) + (screen.screenY || 0);
      if (x < 0 || y < 0 || x > screen.width + (screen.screenX || 0) || y > screen.height + (screen.screenY || 0)) {
        throw new Error(`点击 ${label} 失败：位置 (${x}, ${y}) 在屏幕外 —— 元素被挤出屏幕了（手机布局问题）`);
      }
      const before = await clickCount();
      const t0 = Date.now();
      adb(['shell', 'input', 'tap', String(x), String(y)]);
      const landed = await waitFor(`点击落到 ${label} 上`, () => clickLanded(rect.sel, before), { timeout: 3000, interval: 100 }).then(
        () => true,
        () => false,
      );
      const clicks = await clickLog(before);
      const entry = { label, x, y, css: [Math.round(rect.x), Math.round(rect.y)], landed, clicks, latencyMs: clicks.length ? Date.now() - t0 : null };
      taps.push(entry);
      if (landed) return;
      if (clicks.some((k) => k.type === 'click')) {
        // 点到了别的东西：可能已经触发了别的操作，不能当作没发生，直接报错
        const got = clicks.find((k) => k.type === 'click');
        throw new Error(
          `点击 ${label} 失败：实际点到了 ${got.target}（屏幕坐标 ${x},${y}，点击时 scrollY=${got.scrollY} 视口高 ${got.innerHeight}）`,
        );
      }
      // 点击被挡住：多半是系统弹了「无响应」提示盖在 App 上面，收掉再试
      if (dismissSystemAlerts()) await sleep(800);
      if (attempt >= 3) throw new Error(`点击 ${label} 失败：点了 3 次，页面一次点击事件都没收到（系统输入被别的东西拦住了）`);
      await sleep(300);
    }
  };

  const tap = (selector) => clickAt(() => rectOf(selector), selector);
  const tapText = (text, tag) => clickAt(() => rectByText(text, tag), `文本「${text}」`);

  /** 真实键盘输入（逐字符 key event），等价于软键盘打字 */
  const typeText = async (text) => adb(['shell', 'input', 'text', `'${text.replace(/'/g, "'\\''")}'`]);

  /**
   * 经 DevTools 协议提交一段文字（等价于输入法「上屏」，不产生逐个按键事件）。
   * 模拟器卡顿时 adb 的按键事件会丢字，连丢几次就改用它 —— 页面收到的 input 事件是一样的。
   */
  const insertText = async (text) => send('Input.insertText', { text });

  return { send, evaluate, net, console: console_, screen, dpr, rectOf, rectByText, tap, tapText, taps, typeText, insertText, sseState, ws };
}

/* ---------------------------------------------------------- uiautomator -- */
/** 导出当前屏幕的无障碍节点树（包含 WebView 里的可见文本节点与系统界面） */
export function uiDump() {
  adb(['shell', 'uiautomator', 'dump', '/sdcard/vd-ui.xml'], { allowFail: true });
  const xml = adb(['exec-out', 'cat', '/sdcard/vd-ui.xml'], { allowFail: true }).toString('utf8');
  const nodes = [];
  const re = /<node ([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = a[2].replace(/&amp;/g, '&').replace(/&#39;/g, "'");
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds || '');
    if (b) nodes.push({ ...attrs, x1: +b[1], y1: +b[2], x2: +b[3], y2: +b[4] });
  }
  return nodes;
}

export function uiFind(pred) {
  return uiDump().find((n) => pred(n) && n.x2 > n.x1 && n.y2 > n.y1) ?? null;
}

export function uiTap(node) {
  adb(['shell', 'input', 'tap', String(Math.round((node.x1 + node.x2) / 2)), String(Math.round((node.y1 + node.y2) / 2))]);
}

export function screenshot(name) {
  mkdirSync(ARTIFACTS, { recursive: true });
  const file = path.join(ARTIFACTS, `${name}.png`);
  writeFileSync(file, adb(['exec-out', 'screencap', '-p'], { binary: true }));
  return file;
}

/* ------------------------------------------------------------------ 工具 -- */
export const api = {
  get: (p) => fetch(`http://127.0.0.1:${API_PORT}${p}`).then((r) => r.json()),
  post: (p, body) =>
    fetch(`http://127.0.0.1:${API_PORT}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => r.json()),
};

export const URLS = {
  bili: 'https://www.bilibili.com/video/BV1GJ411x7h7',
  yt: 'https://www.youtube.com/watch?v=A5sE7l8SbL4',
  // 较长的视频（Big Buck Bunny，10 分钟）：用来测试「下载中途暂停 / 终止」
  ytLong: process.env.VD_E2E_YT_LONG || 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
  // 两个分 P 的视频（P2 只有 37 秒）：用来测试「多 P 选集」
  biliMulti: process.env.VD_E2E_BILI_MULTI || 'https://www.bilibili.com/video/BV1j1yBzwE8z',
};

/* --------------------------------------------------------------- 测试框架 -- */
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** 启动/重启 App（纯 adb，不依赖已有连接） */
export async function startApp() {
  adb(['shell', 'am', 'force-stop', PKG]);
  adb(['shell', 'am', 'start', '-n', ACTIVITY]);
  await waitFor('App 进程启动', () => /^\d+$/.test(adb(['shell', 'pidof', PKG], { allowFail: true }).trim()), { timeout: 30000 });
  await waitFor('WebView 调试通道就绪', () => {
    const pid = adb(['shell', 'pidof', PKG]).trim();
    return adb(['shell', 'cat', '/proc/net/unix']).includes('webview_devtools_remote_' + pid);
  }, { timeout: 30000 });
  await sleep(1500); // 等页面首屏渲染
}

/** 重启 App 并重连（App 重启会让旧 DevTools 连接失效） */
export async function relaunch(h) {
  h.c.ws.close();
  await startApp();
  h.c = await connect();
  await waitFor('页面加载出下载按钮', () => h.c.evaluate('!!document.querySelector("#btn")'), { timeout: 30000 });
  await sleep(800); // 等 SSE 连上并拿到初始快照
}

/** 清空页面状态（输入框/弹窗/保存目录），任务列表保持服务端数据 */
export async function resetUi(c) {
  // 保存目录也归位到默认：上一轮半路失败时可能停在用户所选目录上，后面的用例就会把文件下到别处。
  // 需要所选目录的用例（选目录）自己从头选一遍。
  await c.evaluate('localStorage.removeItem("vd.server"); localStorage.removeItem("vd.outdir"); location.reload(); true');
  await waitFor('reload 后页面就绪', () => c.evaluate('!!document.querySelector("#btn") && !!document.querySelector("#input")'), { timeout: 20000 });
  await sleep(600);
  c.net.reset();
  c.console.reset();
}

/** 页面上第一行任务的 {status, text} */
export const firstRow = (c) =>
  c.evaluate(`(() => { const r = document.querySelector('.trow'); return r ? { status: [...r.classList].find(c => c !== 'trow'), text: r.textContent } : null; })()`);

const taskIds = async () => new Set((await api.get('/api/tasks')).tasks.map((t) => t.id));

/** 真实操作：点输入框、键入链接（adb 键盘事件），等界面识别出站点 */
async function typeInto(c, url) {
  for (let attempt = 1; ; attempt++) {
    await c.tap('#input');
    await sleep(400);
    await c.evaluate(`(() => { const ta = document.querySelector('#input'); ta.focus(); document.execCommand('selectAll'); })()`);
    // 系统一卡，adb 发的键盘事件会丢字（链接缺几个字符 → 站点报「链接无效」，看着像 App 的问题）。
    // 所以前两次用真实按键，读回输入框核对，不一致就全选重输；还不行就改用输入法「上屏」的方式（不会丢字）。
    if (attempt <= 2) {
      await c.typeText(url);
    } else {
      if (attempt === 3) console.log('    （按键输入连续丢字符，改用输入法上屏的方式输入）');
      await c.insertText(url);
    }
    const typed = await c.evaluate(`document.querySelector('#input').value`);
    if (typed === url) break;
    if (attempt >= 5) throw new Error(`输入链接后输入框内容不一致（应输入 ${url.length} 个字符，框里只有 ${typed.length} 个）: ${typed}`);
    console.log(`    （输入时丢了字符：${typed.length}/${url.length}，重输）`);
    await sleep(300);
  }
  await waitFor('出现站点识别徽章', () => c.evaluate(`document.querySelectorAll('.detected .ant-tag').length > 0`), { timeout: 10000 });
}

/** 等服务端出现 [before] 之后新增的任务（用点击前后的任务 ID 差集判定，不受历史任务影响） */
function waitNewTask(before, timeout = 15000) {
  return waitFor('界面操作后服务端新增一个任务', async () => (await api.get('/api/tasks')).tasks.find((x) => !before.has(x.id)) ?? false, {
    timeout,
    interval: 250,
  });
}

/** 真实输入链接 → 点「开始下载」→ 返回新建的任务 */
async function submitAndCatch(c, { url, timeout = 15000 }) {
  await typeInto(c, url);
  const before = await taskIds();
  c.net.reset();
  await c.tap('#btn');
  return waitNewTask(before, timeout);
}

/** 把 /api 请求摘要打印出来（调试用） */
const netSummary = (c, all = false) =>
  (all ? c.net.all : c.net.requests)
    .filter((r) => r.url.includes('/api/'))
    // SSE 长连接会反复出现，合并成一条
    .map((r) => `${r.method} ${r.url.split('/api/')[1]} → ${r.failed ? 'FAILED ' + r.failed : r.status ?? '(pending)'}`)
    .filter((line, i, arr) => !line.startsWith('GET events') || arr.indexOf(line) === i)
    .join('\n    ');

/** 任务是否已出现在列表首行（创建时标题可能还没有：显示的是链接，解析后才换成标题） */
async function rowShows(c, t) {
  const r = await firstRow(c);
  if (!r) return false;
  const live = (await api.get('/api/tasks')).tasks.find((x) => x.id === t.id) ?? t;
  return [t.url, t.title, live.title, live.url].filter(Boolean).some((s) => r.text.includes(s));
}

/** 用 ffmpeg 读出媒体信息（流、分辨率、时长）；返回 stderr 文本 */
function mediaInfo(file) {
  return probeText(file);
}

/** 在电脑上跑一个命令，失败就抛出它自己的错误输出 */
function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} 退出码 ${r.status}\n${r.stderr || r.stdout}`);
  return r;
}

/**
 * 电脑端的参考：用 yt-dlp 取同样的两路流，再让 ffmpeg 无损合成。
 * 设备上我们自己合成的结果必须和它逐帧一致。
 */
function ytReference(videoItag, audioItag, url) {
  const dir = path.join(ARTIFACTS, 'yt-ref');
  mkdirSync(dir, { recursive: true });
  const v = path.join(dir, `${videoItag}.mp4`);
  const a = path.join(dir, `${audioItag}.m4a`);
  const muxed = path.join(dir, `${videoItag}+${audioItag}.mp4`);
  if (!existsSync(muxed)) {
    run(YTDLP, ['-f', String(videoItag), '--no-part', '-o', v, url]);
    run(YTDLP, ['-f', String(audioItag), '--no-part', '-o', a, url]);
    run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-i', v, '-i', a, '-c', 'copy', '-map', '0:v:0', '-map', '1:a:0', muxed]);
  }
  return muxed;
}

/** 任务在设备上的缓存目录（YouTube / HLS 的中间文件），通过 run-as 读取 */
const partsListing = (id) => adb(['shell', 'run-as', PKG, 'ls', '-la', `cache/parts/${id}`], { allowFail: true });

/**
 * 把设备上「文件名以 [fileBase] 开头、最新修改」的文件拉回来。
 * 同名文件系统会自动加 " (n)" 后缀，所以按修改时间取最新的那个。
 */
function pullNewest(deviceDir, fileBase, localName) {
  const names = adb(['shell', 'ls', '-t', deviceDir], { allowFail: true }).split('\n').map((s) => s.trim()).filter(Boolean);
  const name = names.find((n) => n.startsWith(fileBase));
  if (!name) return null;
  mkdirSync(ARTIFACTS, { recursive: true });
  const local = path.join(ARTIFACTS, localName);
  adb(['pull', `${deviceDir}/${name}`, local]);
  return { name, local, size: statSync(local).size };
}

/**
 * 把设备上的这一个文件原样拉回来（[devicePath] 相对共享存储根，如 Download/VideoDownloader/xxx (1).mp4）。
 * 同一分钟里下了多个任务时文件名只差一个 "(n)"，按名字前缀找最新会拿错 —— 这种情况必须按完整路径拉。
 */
function pullExact(devicePath, localName) {
  mkdirSync(ARTIFACTS, { recursive: true });
  const local = path.join(ARTIFACTS, localName);
  adb(['pull', `/sdcard/${devicePath}`, local]);
  return { name: path.basename(devicePath), local, size: statSync(local).size };
}

/** 设备上某目录里自 [sinceEpoch] 之后新写入的文件（应为空数组时说明没写到那里） */
function filesNewerThan(deviceDir, sinceEpoch) {
  const out = adb(['shell', 'find', deviceDir, '-type', 'f', '-newermt', `@${Math.floor(sinceEpoch)}`], { allowFail: true });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

const deviceNow = () => Number(adb(['shell', 'date', '+%s']).trim());

/** 等待系统界面上出现满足条件的控件（uiautomator）并返回它 */
const uiWait = (desc, pred, timeout = 15000) => waitFor(desc, () => uiFind(pred), { timeout, interval: 400 });

/** 等某个任务满足条件，返回任务对象；超时的话把任务当前状态和事件流状态附在错误里 */
async function waitTask(c, id, pred, desc, timeout = 600000) {
  return waitFor(
    desc,
    async () => {
      const cur = (await api.get('/api/tasks')).tasks.find((x) => x.id === id);
      return cur && pred(cur) ? cur : false;
    },
    {
      timeout,
      onFail: async (e) => {
        const cur = (await api.get('/api/tasks')).tasks.find((x) => x.id === id);
        e.message +=
          `\n  任务当前状态: ${JSON.stringify({ status: cur?.status, stage: cur?.stage, percent: cur?.percent, error: cur?.error, log: cur?.log?.slice(-10) })}` +
          `\n  实时事件流: ${JSON.stringify(await c.sseState().catch(() => 'n/a'))}`;
      },
    },
  );
}

/** 界面首行的状态 */
const rowStatusIs = (c, status) => firstRow(c).then((r) => r && r.status === status);

/** 把下载下来的文件做完整校验：确实落在 [dir]、大小与任务记录一致、能完整播放 */
function checkDownloaded(done, dir, since, localName, label) {
  const fresh = filesNewerThan(dir, since - 1);
  // 任务记录里是完整路径时按原路径拉：同一分钟里下过的多个任务文件名只差一个 "(n)"，按前缀找最新会拿错
  const prefix = dir.replace(/^\/sdcard\//, '') + '/';
  const exact = done.file?.startsWith(prefix) ? pullExact(done.file, localName) : null;
  const pulled = exact ?? pullNewest(dir, path.basename(done.file, path.extname(done.file)), localName);
  assert.ok(pulled && fresh.includes(`${dir}/${pulled.name}`), `${label}: 新文件应写入 ${dir}:\n  新文件: ${JSON.stringify(fresh)}`);
  assert.equal(pulled.size, done.sizeBytes, `${label}: 文件大小应与任务记录一致`);
  return { ...pulled, ...assertPlayable(pulled.local, { label }) };
}

/* ---------------------------------------------------------------- 用例 -- */
test('launch: 应用启动、页面渲染、无控制台错误', async (h) => {
  await relaunch(h);
  const c = h.c; // 重启后必须用新连接
  await sleep(1500);
  assert.equal(await c.evaluate('document.title'), 'Video Downloader');
  assert.ok(await c.evaluate('!!document.querySelector("#btn")'), '应有下载按钮');
  assert.ok(await c.evaluate('!!document.querySelector("#input")'), '应有输入框');
  assert.deepEqual(c.console.errors, [], '启动阶段不应有控制台错误');
});

test('download-bili: 真实输入 B站链接 → 点击开始下载 → 任务完成并落盘', async (h) => {
  const c = h.c;
  await resetUi(c);
  const dir = DEFAULT_DIR;
  const since = deviceNow();
  let t;
  try {
    t = await submitAndCatch(c, { url: URLS.bili });
  } catch (e) {
    const inputVal = await c.evaluate(`document.querySelector('#input').value`);
    const btnText = await c.evaluate(`document.querySelector('#btn').textContent`);
    e.message += `\n  点击时输入框内容: ${inputVal}\n  按钮文案: ${btnText}\n  /api 请求记录:\n    ${netSummary(c) || '(无)'}`;
    throw e;
  }
  assert.equal(t.site, 'bilibili');
  // 输入框被清空 + 新任务出现在列表首行（界面经实时事件流更新，不是靠刷新页面）
  await waitFor('提交后输入框清空', () => c.evaluate(`document.querySelector('#input').value === ''`), { timeout: 5000 });
  await waitFor('新任务出现在列表首行', () => rowShows(c, t), {
    timeout: 10000,
    onFail: async (e) => {
      e.message += `\n  实时事件流状态: ${JSON.stringify(await c.sseState().catch(() => 'n/a'))}\n  页面加载以来的 /api 请求:\n    ${netSummary(c, true) || '(无)'}`;
    },
  });

  // 实时性：下载过程中界面应在几秒内显示「下载中」状态（而不是等下载结束才刷新）
  await waitFor(
    '下载过程中首行显示进度',
    async () => {
      const r = await firstRow(c);
      return r && (r.text.includes('%') || r.text.includes('/s'));
    },
    { timeout: 15000 },
  );

  const done = await waitFor('任务完成（以服务端状态为准）', async () => (await api.get('/api/tasks')).tasks.find((x) => x.id === t.id && x.status === 'done') ?? false, {
    timeout: 240000,
    onFail: async (e) => {
      const cur = (await api.get('/api/tasks')).tasks.find((x) => x.id === t.id);
      e.message += `\n  任务当前状态: ${JSON.stringify({ status: cur?.status, stage: cur?.stage, error: cur?.error, log: cur?.log })}`;
    },
  });
  await waitFor('界面首行变为完成', () => firstRow(c).then((r) => r && r.status === 'done'), { timeout: 10000 });

  // 文件确实落盘，且内容是对的（不是只看「文件存在」）
  const fresh = filesNewerThan(dir, since - 1);
  const pulled = pullNewest(dir, path.basename(done.file, '.mp4'), 'bili.mp4');
  assert.ok(pulled && fresh.includes(`${dir}/${pulled.name}`), `新文件应写入 ${dir}:\n  新文件: ${JSON.stringify(fresh)}`);
  assert.equal(pulled.size, done.sizeBytes, '文件大小应与任务记录一致');
  const info = mediaInfo(pulled.local);
  assert.match(info, /Video: h264/, '应为 H.264 视频:\n' + info);
  assert.match(info, /1280x720/, '游客 html5 接口应给到 720P:\n' + info);
  assert.match(info, /Audio: aac/, '应有 AAC 音轨:\n' + info);
  const errs = decodeErrors(pulled.local);
  assert.equal(errs, '', '完整解码不应有错误:\n' + errs);
  console.log(`    文件: ${done.file} (${pulled.size} 字节) ${info.match(/Duration: [^,]+/)?.[0]}`);
});

/* ------------------------------------------------------- 系统文件夹选择器 -- */
const useBtn = (n) => n['resource-id'] === 'android:id/button1' && n.text === 'USE THIS FOLDER';
/** 选择器当前所在的目录 = 面包屑的最后一级 */
const currentFolder = () => uiDump().filter((n) => n['resource-id'] === `${DOCS}:id/breadcrumb_text`).map((n) => n.text).pop();
const pickerIn = (name) => waitFor(`系统文件夹选择器停在 ${name}`, async () => (await currentFolder()) === name, { timeout: 10000 });

/** 关掉选择器：系统返回键在子目录里是回到上一级，到了根目录才是退出 */
async function closePicker() {
  for (let i = 0; i < 5 && uiFind(useBtn); i++) {
    adb(['shell', 'input', 'keyevent', '4']);
    await sleep(700);
  }
  await waitFor('系统文件夹选择器关闭', () => !uiFind(useBtn), { timeout: 8000 });
}

/** 收掉可能还开着的系统界面，让 App 回到最前面 */
async function recoverUi(c) {
  dismissSystemAlerts();
  if (uiFind(useBtn)) await closePicker();
  adb(['shell', 'am', 'start', '-n', ACTIVITY], { allowFail: true });
  // 页面也复位：上一个用例半路失败时可能留着没关的弹窗（选集窗口之类），它的遮罩会挡住后面的点击
  if (c) await c.evaluate('localStorage.removeItem("vd.outdir"); location.reload(); true').catch(() => {});
}

/**
 * 收掉挡在 App 前面的系统「无响应」提示（"System UI isn't responding" 之类）。
 * 模拟器跑久了系统界面会卡出这种框，它一出现 App 就收不到任何点击，后面的用例会全军覆没。
 * 如果卡住的正是 App 自己，不点「等待」—— 那是真问题，应该让用例失败。
 * @returns 是否点掉了
 */
function dismissSystemAlerts() {
  const wait = uiFind((n) => n['resource-id'] === 'android:id/aerr_wait');
  if (!wait) return false;
  // 标题形如 "System UI isn't responding"（有些系统上这个标题节点没有固定 id，按文字认）
  const ours = uiFind((n) => (n['resource-id'] === 'android:id/alertTitle' || n.class === 'android.widget.TextView') && (n.text || '').includes(APP_LABEL));
  if (ours) return false;
  uiTap(wait);
  console.log('    （系统弹了「… isn\'t responding」提示，已点「等待」）');
  return true;
}

/** 在已经打开的选择器里选「下载/VD_E2E」并确认（第一次运行时顺手把文件夹建出来）；返回页面上回填的目录 */
async function confirmPickFolder(c) {
  // 回到上一级「下载」目录：系统不允许选这一层，确认按钮是灰色的（所以才要进一个子目录）
  adb(['shell', 'input', 'keyevent', '4']);
  await pickerIn('Download');
  assert.equal(uiFind(useBtn).enabled, 'false', '「下载」根目录系统不让选，确认按钮应为灰色');

  if (adb(['shell', 'ls', '-d', PICK_DIR], { allowFail: true }).trim().length === 0) {
    // 第一次运行：在选择器里新建目标文件夹
    uiTap(uiFind((n) => n['resource-id'] === `${DOCS}:id/option_menu_create_dir`));
    uiTap(await uiWait('新建文件夹对话框', (n) => n.class === 'android.widget.EditText'));
    await sleep(500);
    adb(['shell', 'input', 'text', PICK_FOLDER]);
    await sleep(500);
    uiTap(await uiWait('确认新建', (n) => n['resource-id'] === 'android:id/button1' && n.text === 'OK'));
  } else {
    uiTap(await uiWait(`列表里出现 ${PICK_FOLDER}`, (n) => n['resource-id'] === 'android:id/title' && n.text === PICK_FOLDER));
  }
  await pickerIn(PICK_FOLDER);
  assert.equal(uiFind(useBtn).enabled, 'true', '进入子目录后确认按钮应可点');
  uiTap(uiFind(useBtn));
  // 系统会再确认一次访问授权
  uiTap(await uiWait('系统授权确认框', (n) => n['resource-id'] === 'android:id/button1' && /^(ALLOW|允许)$/.test(n.text)));

  // 回到 App：输入框里显示的是目录名（一长串 content:// 地址放在 title 里）
  const picked = await waitFor(
    '输入框显示所选目录',
    async () => {
      const v = await c.evaluate(`(() => { const el = document.querySelector('#outdir'); return { label: el.value, uri: el.title, readOnly: el.readOnly }; })()`);
      return v.uri.startsWith('content://') ? v : false;
    },
    { timeout: 15000 },
  );
  assert.equal(picked.label, PICK_FOLDER, '输入框里应显示所选目录的名字');
  assert.equal(picked.readOnly, true, '安卓上目录只能通过系统选择器选，不能手输');
  return picked;
}

test('pick-dir-download: 点「浏览…」→ 系统文件夹选择器停在当前目录 → 选一个文件夹 → 下载的文件写入所选目录', async (h) => {
  const c = h.c;
  await resetUi(c);
  // 恢复默认目录，确保下面的选择是从零开始
  await c.tap('#dir-reset');
  await waitFor('目录恢复默认', () => c.evaluate(`document.querySelector('#outdir').value === ''`), { timeout: 5000 });

  // 第一次使用：默认目录还不存在（一次都没下载过）。点「浏览…」时 App 应把它建出来，
  // 选择器直接停在里面、确认按钮可点 —— 而不是停在系统不让选的「下载」根目录
  //（那里只有一句「Can't use this folder」和一个灰掉的按钮，像是功能坏了）
  adb(['shell', 'rm', '-rf', DEFAULT_DIR], { allowFail: true });
  await c.tap('#dir-browse');
  await uiWait('系统文件夹选择器出现', useBtn);
  await pickerIn('VideoDownloader');
  assert.equal(uiFind(useBtn).enabled, 'true', '停在默认目录时「USE THIS FOLDER」应可点');

  const picked = await confirmPickFolder(c);
  const outDir = picked.uri;
  assert.ok(outDir.includes('VD_E2E') || decodeURIComponent(outDir).includes(PICK_FOLDER), `所选目录 URI 应指向 ${PICK_FOLDER}: ${outDir}`);

  // 用所选目录下载
  const since = deviceNow();
  const t = await submitAndCatch(c, { url: URLS.bili });
  const done = await waitFor('任务完成', async () => (await api.get('/api/tasks')).tasks.find((x) => x.id === t.id && x.status === 'done') ?? false, {
    timeout: 240000,
    onFail: async (e) => {
      const cur = (await api.get('/api/tasks')).tasks.find((x) => x.id === t.id);
      e.message += `\n  任务当前状态: ${JSON.stringify({ status: cur?.status, stage: cur?.stage, error: cur?.error, log: cur?.log })}`;
    },
  });
  assert.equal(done.outDir, outDir, '任务应带上用户所选目录');
  assert.ok(done.file.startsWith(PICK_FOLDER), `文件路径应显示为所选目录下的文件: ${done.file}`);

  // 文件必须真的出现在所选目录里，而不是落到默认目录
  const inPicked = pullNewest(PICK_DIR, path.basename(done.file, '.mp4'), 'bili-picked.mp4');
  assert.ok(inPicked, `文件应写入所选目录 ${PICK_DIR}`);
  assert.equal(inPicked.size, done.sizeBytes);
  assert.match(mediaInfo(inPicked.local), /Video: h264/);
  assert.deepEqual(filesNewerThan(DEFAULT_DIR, since - 1), [], '默认目录里不应出现新文件');

  // 重置回默认目录，不影响后续用例
  await c.tap('#dir-reset');
  await waitFor('目录恢复默认', () => c.evaluate(`document.querySelector('#outdir').value === ''`), { timeout: 5000 });
  console.log(`    所选目录: ${outDir}\n    文件: ${done.file} (${inPicked.size} 字节)`);
});

test('pick-dir-again: 已选过目录后再点「浏览…」→ 选择器停在上次选的目录 → 取消后保存目录不变', async (h) => {
  const c = h.c;
  await resetUi(c);
  await c.tap('#dir-browse');
  await uiWait('系统文件夹选择器出现', useBtn);
  await pickerIn('VideoDownloader');
  await confirmPickFolder(c);
  const chosen = await c.evaluate(`document.querySelector('#outdir').title`);

  // 再点一次：这次应停在上次选的目录里（直接确认，或者换一个都方便），而不是从头找起
  await c.tap('#dir-browse');
  await uiWait('系统文件夹选择器再次出现', useBtn);
  await pickerIn(PICK_FOLDER);
  assert.equal(uiFind(useBtn).enabled, 'true', '停在上次选的目录时确认按钮应可点');

  // 不选了
  await closePicker();
  const outdir = await c.evaluate(`(() => { const el = document.querySelector('#outdir'); return { label: el.value, uri: el.title }; })()`);
  assert.equal(outdir.label, PICK_FOLDER, '取消选择后仍应是上次的目录');
  assert.equal(outdir.uri, chosen, '取消选择不应改变保存目录');

  // 收尾：恢复默认目录
  await c.tap('#dir-reset');
  await waitFor('目录恢复默认', () => c.evaluate(`document.querySelector('#outdir').value === ''`), { timeout: 5000 });
});
test('download-yt: 真实输入 YouTube 链接 → 下载 → 合成的 MP4 与电脑端参考逐帧一致', async (h) => {
  const c = h.c;
  await resetUi(c);
  const since = deviceNow();
  const t = await submitAndCatch(c, { url: URLS.yt, timeout: 30000 });
  assert.equal(t.site, 'youtube');
  await waitFor('新任务出现在列表首行', () => rowShows(c, t), { timeout: 10000 });
  // 过程中界面应依次出现「解析」「下载」等阶段（实时事件流在工作）
  await waitFor(
    '下载过程中界面显示阶段/进度',
    async () => {
      const r = await firstRow(c);
      return r && r.status === 'running' && (/下载视频流|合成音视频|下载音频流/.test(r.text) || r.text.includes('%'));
    },
    { timeout: 60000 },
  );
  const done = await waitTask(c, t.id, (x) => x.status === 'done', 'YouTube 任务完成');
  await waitFor('界面首行变为完成', () => rowStatusIs(c, 'done'), { timeout: 10000 });
  console.log('    日志: ' + (done.log || []).join(' | '));

  const file = checkDownloaded(done, DEFAULT_DIR, since, 'yt.mp4', 'YouTube');
  assert.equal(partsListing(t.id).trim(), '', '合成完成后应清理缓存里的中间文件');
  console.log(`    文件: ${done.file} (${file.size} 字节) ${file.resolution} 时长 ${file.duration.toFixed(2)}s`);

  // 最关键的一步：设备上合成的文件，必须和电脑端「同样的两路流 + ffmpeg 合成」逐帧一致
  const log = (done.log || []).join('\n');
  const itags = /视频流 itag (\d+).*?音频流 itag (\d+)/.exec(log);
  assert.ok(itags, `日志里应记录选中的 itag:\n${log}`);
  const ref = ytReference(Number(itags[1]), Number(itags[2]), URLS.yt);
  const frames = assertSameVideo(file.local, ref, '设备合成 vs 电脑端 ffmpeg 合成');
  assertSameAudio(file.local, ref, 'YouTube：设备合成 vs 电脑端 ffmpeg 合成');
  const av = assertAVSync(file.local, ref, "YouTube：音画起点关系（设备上的结果 vs ffmpeg 参考）");
  console.log(`    音画起点：视频比音频${av.mine >= 0 ? '晚' : '早'} ${(Math.abs(av.mine) * 1000).toFixed(1)}ms（参考 ${(Math.abs(av.ref) * 1000).toFixed(1)}ms）`);
  console.log(`    与电脑端参考逐帧一致：${frames} 帧（画面哈希 + 显示时刻），音频解码一致`);
});

test('pause-resume-yt: 下载中途点「暂停」→ 点「恢复」从断点继续并完成', async (h) => {
  const c = h.c;
  await resetUi(c);
  const since = deviceNow();
  const t = await submitAndCatch(c, { url: URLS.ytLong, timeout: 30000 });

  // 等视频流下了一小段再暂停
  const running = await waitTask(c, t.id, (x) => x.status === 'running' && x.percent >= 3, '下载进度 ≥ 3%', 120000);
  await c.tap('.trow [data-act="pause"]');
  const paused = await waitTask(c, t.id, (x) => x.status === 'paused', '任务变为暂停', 30000);
  await waitFor('界面首行显示「暂停」', () => rowStatusIs(c, 'paused'), { timeout: 5000 });
  assert.ok(paused.downloaded > 0, '暂停时应已有进度');
  const parts = partsListing(t.id);
  assert.match(parts, /video\.mp4\.part/, `暂停后应保留断点文件供恢复:\n${parts}`);
  await sleep(1500); // 停一会儿，确认暂停后不再继续下载
  assert.equal((await api.get('/api/tasks')).tasks.find((x) => x.id === t.id).downloaded, paused.downloaded, '暂停后进度不应变化');

  // 恢复：从断点继续
  await c.tap('.trow [data-act="retry"]');
  await waitTask(c, t.id, (x) => x.status === 'running' || x.status === 'queued', '任务恢复运行', 30000);
  const done = await waitTask(c, t.id, (x) => x.status === 'done', '恢复后下载完成', 900000);
  await waitFor('界面首行变为完成', () => rowStatusIs(c, 'done'), { timeout: 10000 });
  const log = (done.log || []).join('\n');
  assert.match(log, /视频流从断点继续（已有 \d+ MB）/, `恢复时应接着上次的断点继续:\n${log}`);
  assert.equal(partsListing(t.id).trim(), '', '完成后应清理缓存');
  const file = checkDownloaded(done, DEFAULT_DIR, since, 'yt-resumed.mp4', 'YouTube（恢复后）');
  console.log(`    暂停时已下载 ${(paused.downloaded / 1048576).toFixed(1)} MB；${log.split('\n').find((l) => l.includes('断点继续'))}`);
  console.log(`    文件: ${done.file} (${(file.size / 1048576).toFixed(1)} MB) ${file.resolution} 时长 ${file.duration.toFixed(1)}s`);
});

test('cancel-yt: 下载中途点「终止」→ 任务终止、缓存清空、不留下半成品', async (h) => {
  const c = h.c;
  await resetUi(c);
  const since = deviceNow();
  const t = await submitAndCatch(c, { url: URLS.ytLong, timeout: 30000 });
  await waitTask(c, t.id, (x) => x.status === 'running' && x.percent >= 3, '下载进度 ≥ 3%', 120000);
  await c.tap('.trow [data-act="cancel"]');
  await waitTask(c, t.id, (x) => x.status === 'cancelled', '任务变为终止', 30000);
  await waitFor('界面首行显示「终止」', () => rowStatusIs(c, 'cancelled'), { timeout: 5000 });
  await sleep(1500);
  assert.equal(partsListing(t.id).trim(), '', '终止后应清掉缓存里的中间文件');
  assert.deepEqual(filesNewerThan(DEFAULT_DIR, since - 1), [], '终止后不应留下半成品文件');
  // 终止后不会自己继续跑
  await sleep(3000);
  assert.equal((await api.get('/api/tasks')).tasks.find((x) => x.id === t.id).status, 'cancelled');
});

test('detail-drawer: 点任务行打开详情（标题、链接、日志），再关闭', async (h) => {
  const c = h.c;
  await resetUi(c);
  const top = (await api.get('/api/tasks')).tasks[0];
  await c.tap('.trow .t-title');
  await waitFor('详情抽屉打开', () => c.evaluate(`!!document.querySelector('.ant-drawer-open')`), { timeout: 8000 });
  const text = await c.evaluate(`document.querySelector('.ant-drawer-open').textContent`);
  assert.ok(text.includes(top.title || '') || text.includes(top.url), '详情里应显示标题或链接');
  assert.ok(text.includes(top.url), '详情里应显示原始链接');
  await c.tap('.ant-drawer-open .ant-drawer-close');
  await waitFor('详情抽屉关闭', () => c.evaluate(`!document.querySelector('.ant-drawer-open')`), { timeout: 8000 });
});

test('settings: 打开设置 → 保存 HLS 站点域名（自动归一化）→ 切换界面语言', async (h) => {
  const c = h.c;
  await resetUi(c);
  const before = await api.get('/api/config');
  assert.equal(before.platform, 'android');
  await c.tap('#gear');
  await waitFor('设置面板展开', () => c.evaluate(`document.querySelector('#settings').classList.contains('open')`), { timeout: 8000 });

  // HLS 站点：带协议、路径、大小写混写的域名应被归一化成纯域名
  // （输入后读回核对：系统卡顿时 adb 的键盘事件会丢字，不一致就全选重输）
  const domainsText = 'Example.COM/path\nstream.example.org';
  for (let attempt = 1; ; attempt++) {
    await c.tap('#hls-input');
    await sleep(400);
    await c.evaluate(`(() => { const el = document.querySelector('#hls-input'); el.focus(); el.select(); })()`);
    await c.typeText('Example.COM/path');
    adb(['shell', 'input', 'keyevent', '66']); // 换行
    await sleep(300);
    await c.typeText('stream.example.org');
    await sleep(300);
    const typed = (await c.evaluate(`document.querySelector('#hls-input').value`)).replace(/\r/g, '');
    if (typed === domainsText) break;
    if (attempt >= 3) throw new Error(`设置里的域名输入后内容不一致（应输入 ${JSON.stringify(domainsText)}，框里是 ${JSON.stringify(typed)}）`);
  }
  await c.tap('#hls-save');
  await waitFor('服务端保存了归一化后的域名', async () => JSON.stringify((await api.get('/api/config')).hlsSites) === JSON.stringify(['example.com', 'stream.example.org']), {
    timeout: 10000,
  });
  await waitFor('输入框回填成归一化后的值', () => c.evaluate(`document.querySelector('#hls-input').value.replace(/\\r/g, '') === 'example.com\\nstream.example.org'`), { timeout: 5000 });
  // 归一化后这些域名下的链接就能被识别为 HLS 站点
  const parsed = await api.post('/api/parse', { input: 'https://www.stream.example.org/a/b' });
  assert.equal(parsed.urls[0].site, 'hls-generic');

  // 语言切换：界面文案应变成英文，再切回中文
  await c.tapText('English');
  await waitFor('界面切换为英文', () => c.evaluate(`document.querySelector('.controls')?.textContent.includes('Save to')`), { timeout: 8000 });
  await c.tapText('中文');
  await waitFor('界面切回中文', () => c.evaluate(`document.querySelector('.controls')?.textContent.includes('保存到')`), { timeout: 8000 });

  // 还原设置，不影响后续用例
  await api.post('/api/config', { hlsSites: before.hlsSites });
  await resetUi(c);
});

test('delete-history: 不支持的站点显示明确的失败原因 → 可以删除这条记录', async (h) => {
  const c = h.c;
  await resetUi(c);
  // 清掉以前运行留下的同类记录；每次用唯一的链接，免得断言被残留数据干扰
  for (const old of (await api.get('/api/tasks')).tasks) {
    if (old.url.includes('/E2E_DELETE_') || old.url.includes('/DIAG')) await api.post('/api/history/delete', { id: old.id });
  }
  const marker = `E2E_DELETE_${Date.now().toString(36)}`;
  const r = await api.post('/api/download', { input: `https://v.douyin.com/${marker}/`, quality: null, audio: false, outDir: null, playlistItems: null });
  const t = r.tasks[0];
  assert.equal(t.status, 'error');
  await waitFor('失败任务出现在列表首行（界面实时更新）', () => rowShows(c, t), { timeout: 10000 });
  await waitFor('首行显示为失败', () => rowStatusIs(c, 'error'), { timeout: 5000 });

  // 失败原因要能在界面上看到
  await c.tap('.trow .t-title');
  await waitFor('详情抽屉打开', () => c.evaluate(`!!document.querySelector('.ant-drawer-open')`), { timeout: 8000 });
  const text = await c.evaluate(`document.querySelector('.ant-drawer-open').textContent`);
  assert.ok(text.includes('暂不支持抖音'), '详情里应写明失败原因:\n' + text.slice(0, 400));
  await c.tap('.ant-drawer-open .ant-drawer-close');
  await waitFor('详情抽屉关闭', () => c.evaluate(`!document.querySelector('.ant-drawer-open')`), { timeout: 8000 });

  // 删除：点垃圾桶 → 确认
  await c.tap('.trow .anticon-delete');
  await waitFor('弹出删除确认', () => c.evaluate(`!!document.querySelector('.ant-popconfirm:not(.ant-popover-hidden) .ant-btn-primary')`), { timeout: 8000 });
  await c.tap('.ant-popconfirm:not(.ant-popover-hidden) .ant-btn-primary');
  await waitFor('记录从服务端移除', async () => !(await taskIds()).has(t.id), { timeout: 8000 });
  await waitFor('记录从界面上消失', async () => !(await c.evaluate(`document.body.textContent`)).includes(marker), { timeout: 8000 });
});

/* ------------------------------------------------------------- HLS 用例 -- */

/**
 * 网页链接要被当成 HLS 站点处理，得先把测试源的域名加进设置（和用户在设置里添加站点域名是同一个接口）。
 * 跑完后还原。
 */
async function withHlsDomains(domains, fn) {
  const before = (await api.get('/api/config')).hlsSites;
  await api.post('/api/config', { hlsSites: [...before, ...domains] });
  try {
    return await fn();
  } finally {
    await api.post('/api/config', { hlsSites: before });
  }
}

/** 走一遍真实界面下载，等完成并返回任务和落盘文件 */
async function downloadThroughUi(h, url, localName, label, { timeout = 180000 } = {}) {
  const c = h.c;
  await resetUi(c);
  const since = deviceNow();
  const t = await submitAndCatch(c, { url, timeout: 30000 });
  const done = await waitTask(c, t.id, (x) => x.status === 'done', `${label}：任务完成`, timeout);
  await waitFor(`${label}：界面首行变为完成`, () => rowStatusIs(c, 'done'), { timeout: 10000 });
  console.log('    日志: ' + (done.log || []).join(' | '));
  const file = checkDownloaded(done, DEFAULT_DIR, since, localName, label);
  return { t, done, file };
}

test('hls-direct: 直接的 m3u8 链接（主列表 → AES-128 加密的 TS 分段）→ 下载并转成 MP4，与 ffmpeg 的参考逐帧一致', async (h) => {
  const hls = h.hls;
  hls.requests.length = 0;
  const { done, file } = await downloadThroughUi(h, hls.url('master.m3u8'), 'hls-aes.mp4', 'HLS');
  assert.equal(done.site, 'hls-generic');
  // 选了高的那一档（加密的 TS），并且真的去取了密钥
  assert.match((done.log || []).join('\n'), /清晰度 360p/);
  const paths = hls.requests.map((r) => r.path);
  for (const p of ['/master.m3u8', '/ts-aes/index.m3u8', '/ts-aes/enc.key']) {
    assert.ok(paths.includes(p), `App 应请求过 ${p}:\n${paths.join('\n')}`);
  }
  assert.ok(paths.includes('/ts-aes/seg000.ts') && paths.some((p) => /^\/ts-aes\/seg\d+\.ts$/.test(p)));
  const ref = path.join(hls.ref, 'ts-aes.mp4');
  const frames = assertSameVideo(file.local, ref, 'HLS（AES-128 TS → MP4）：设备上的结果 vs ffmpeg 参考');
  assertSameAudio(file.local, ref, 'HLS：音频（设备上的结果 vs ffmpeg 参考）');
  const av = assertAVSync(file.local, ref, "HLS：音画起点关系（设备上的结果 vs ffmpeg 参考）");
  console.log(`    音画起点：视频比音频${av.mine >= 0 ? '晚' : '早'} ${(Math.abs(av.mine) * 1000).toFixed(1)}ms（参考 ${(Math.abs(av.ref) * 1000).toFixed(1)}ms）`);
  console.log(`    文件: ${done.file} (${file.size} 字节) ${file.resolution}；与 ffmpeg 参考逐帧一致：${frames} 帧`);
});

test('hls-fmp4: fMP4 分段的 HLS → 下载并合成 MP4，与 ffmpeg 的参考逐帧一致', async (h) => {
  const { done, file } = await downloadThroughUi(h, h.hls.url('fmp4/index.m3u8'), 'hls-fmp4.mp4', 'HLS fMP4');
  const ref = path.join(h.hls.ref, 'fmp4.mp4');
  const frames = assertSameVideo(file.local, ref, 'HLS（fMP4 → MP4）：设备上的结果 vs ffmpeg 参考');
  assertSameAudio(file.local, ref, 'HLS：音频（设备上的结果 vs ffmpeg 参考）');
  const av = assertAVSync(file.local, ref, "HLS：音画起点关系（设备上的结果 vs ffmpeg 参考）");
  console.log(`    音画起点：视频比音频${av.mine >= 0 ? '晚' : '早'} ${(Math.abs(av.mine) * 1000).toFixed(1)}ms（参考 ${(Math.abs(av.ref) * 1000).toFixed(1)}ms）`);
  console.log(`    文件: ${done.file} (${file.size} 字节)；与 ffmpeg 参考逐帧一致：${frames} 帧`);
});

test('hls-page: 网页链接 → 打开网页找到播放列表 → 下载（请求带上网页的 Referer）', async (h) => {
  const hls = h.hls;
  await withHlsDomains([new URL(hls.url('')).hostname], async () => {
    hls.requests.length = 0;
    const page = hls.url('page.html');
    const { done, file } = await downloadThroughUi(h, page, 'hls-page.mp4', 'HLS 网页');
    assert.equal(done.title, '测试视频页面', '应使用网页标题作为标题');
    assert.ok(hls.requests.some((r) => r.path === '/page.html'), 'App 应加载过网页');
    const playlist = hls.requests.find((r) => r.path === '/ts-plain/index.m3u8' && r.headers.referer);
    assert.ok(playlist, '请求播放列表时应带 Referer:\n' + JSON.stringify(hls.requests.map((r) => r.path)));
    assert.equal(playlist.headers.referer, page);
    const ref = path.join(hls.ref, 'ts-plain.mp4');
    assertSameVideo(file.local, ref, 'HLS（网页 → 明文 TS → MP4）vs ffmpeg 参考');
    assertSameAudio(file.local, ref, 'HLS 网页：音频（设备上的结果 vs ffmpeg 参考）');
  const av = assertAVSync(file.local, ref, "HLS 网页：音画起点关系（设备上的结果 vs ffmpeg 参考）");
  console.log(`    音画起点：视频比音频${av.mine >= 0 ? '晚' : '早'} ${(Math.abs(av.mine) * 1000).toFixed(1)}ms（参考 ${(Math.abs(av.ref) * 1000).toFixed(1)}ms）`);
  });
});

test('hls-challenge: 网页需要人机验证 → 自动弹出网页窗口 → 真实点击通过验证 → 自动继续下载', async (h) => {
  const c = h.c;
  const hls = h.hls;
  await withHlsDomains([new URL(hls.url('')).hostname], async () => {
    await resetUi(c);
    const t = await submitAndCatch(c, { url: hls.url('challenge.html'), timeout: 30000 });
    // 网页窗口出现，里面有待点击的验证按钮
    const button = await uiWait('弹出人机验证网页', (n) => n.text === 'I am human', 30000);
    assert.equal((await api.get('/api/tasks')).tasks.find((x) => x.id === t.id).status, 'running', '等待验证期间任务应保持进行中');
    uiTap(button);
    const done = await waitTask(c, t.id, (x) => x.status === 'done', '通过验证后下载完成');
    assert.equal(done.title, '验证通过后的视频页');
    await waitFor('网页窗口自动关闭', () => !uiFind((n) => n.text === 'I am human'), { timeout: 10000 });
    await waitFor('界面首行变为完成', () => rowStatusIs(c, 'done'), { timeout: 10000 });
    const file = checkDownloaded(done, DEFAULT_DIR, 0, 'hls-challenge.mp4', 'HLS 人机验证');
    assertSameVideo(file.local, path.join(hls.ref, 'ts-aes.mp4'), 'HLS（验证后下载的加密 TS → MP4）vs ffmpeg 参考');
    assertSameAudio(file.local, path.join(hls.ref, 'ts-aes.mp4'), 'HLS（验证后下载）：音频');
    assertAVSync(file.local, path.join(hls.ref, 'ts-aes.mp4'), 'HLS（验证后下载）：音画起点关系');
    console.log(`    文件: ${done.file} (${file.size} 字节)`);
  });
});

test('hls-challenge-cancel: 人机验证窗口里点「取消」→ 任务终止、窗口关闭', async (h) => {
  const c = h.c;
  const hls = h.hls;
  await withHlsDomains([new URL(hls.url('')).hostname], async () => {
    await resetUi(c);
    const t = await submitAndCatch(c, { url: hls.url('challenge.html'), timeout: 30000 });
    await uiWait('弹出人机验证网页', (n) => n.text === 'I am human', 30000);
    uiTap(await uiWait('窗口里有取消按钮', (n) => n.text === '取消' && n.class === 'android.widget.Button'));
    await waitTask(c, t.id, (x) => x.status === 'cancelled', '任务变为已终止', 15000);
    await waitFor('网页窗口关闭', () => !uiFind((n) => n.text === 'I am human'), { timeout: 8000 });
    await waitFor('界面首行显示终止', () => rowStatusIs(c, 'cancelled'), { timeout: 8000 });
  });
});

test('pause-resume-hls: 分段下载中途点「暂停」→「恢复」后从断点继续并完成', async (h) => {
  const c = h.c;
  const hls = h.hls;
  hls.slowDown(400, '/ts-plain/seg'); // 放慢分段响应，留出暂停的时间窗口
  try {
    await resetUi(c);
    const since = deviceNow();
    const t = await submitAndCatch(c, { url: hls.url('ts-plain/index.m3u8'), timeout: 30000 });
    await waitTask(c, t.id, (x) => x.status === 'running' && x.percent >= 20, '分段下载进度 ≥ 20%', 120000);
    await c.tap('.trow [data-act="pause"]');
    const paused = await waitTask(c, t.id, (x) => x.status === 'paused', '任务暂停', 30000);
    assert.match(partsListing(t.id), /stream\.done/, '暂停后应保留进度文件');
    hls.slowDown(0);
    await c.tap('.trow [data-act="retry"]');
    const done = await waitTask(c, t.id, (x) => x.status === 'done', '恢复后下载完成');
    assert.match((done.log || []).join('\n'), /分段从断点继续下载/);
    assert.equal(partsListing(t.id).trim(), '', '完成后应清理缓存');
    const file = checkDownloaded(done, DEFAULT_DIR, since, 'hls-resumed.mp4', 'HLS（恢复后）');
    assertSameVideo(file.local, path.join(hls.ref, 'ts-plain.mp4'), 'HLS（暂停恢复后）vs ffmpeg 参考');
    assertSameAudio(file.local, path.join(hls.ref, 'ts-plain.mp4'), 'HLS（暂停恢复后）：音频');
    assertAVSync(file.local, path.join(hls.ref, 'ts-plain.mp4'), 'HLS（暂停恢复后）：音画起点关系');
    console.log(`    暂停时进度 ${paused.percent.toFixed(0)}%；文件: ${done.file} (${file.size} 字节)`);
  } finally {
    hls.slowDown(0);
  }
});

test('multi-part-bili: 多 P 视频 → 弹出选集窗口 → 只勾选 P2 → 下载的就是 P2', async (h) => {
  const c = h.c;
  await resetUi(c);
  const since = deviceNow();
  await typeInto(c, URLS.biliMulti);
  const before = await taskIds();
  await c.tap('#btn');
  await waitFor('弹出选集窗口', () => c.evaluate(`!!document.querySelector('.ant-modal .ant-list-item')`), { timeout: 30000 });
  const readItems = () =>
    c.evaluate(
      `[...document.querySelectorAll('.ant-modal .ant-list-item')].map((li) => ({ title: li.querySelector('.ant-list-item-meta-title')?.textContent ?? '', checked: li.querySelector('input[type=checkbox]')?.checked }))`,
    );
  // 分 P 的数量以视频当前为准（UP 主会往后加）：只要求至少两个，第二项是 P2
  const items = await readItems();
  assert.ok(items.length >= 2, `至少应有两个分 P，实际 ${items.length}`);
  assert.ok(items.every((x) => x.checked), '默认全选');
  assert.ok(items[1].title.includes('P2'), '第二项应是 P2：' + items.map((x) => x.title).join(' | '));
  assert.equal((await taskIds()).size, before.size, '没确认之前不应创建任务');

  // 真实点击：先「全不选」，再勾上 P2 —— 不管这个视频有几个分 P，选中的都只有 P2
  await c.tapText('全不选');
  await waitFor('全部取消勾选', async () => (await readItems()).every((x) => !x.checked), { timeout: 5000 });
  await c.tap('.ant-modal .ant-list-item:nth-of-type(2) .ant-checkbox');
  await waitFor('只勾选了 P2', async () => {
    const now = await readItems();
    return now[1].checked && now.filter((x) => x.checked).length === 1;
  }, { timeout: 5000 });

  // 点「下载选中（1 个）」
  await c.tapText('下载选中（1 个）');
  const t = await waitNewTask(before, 30000);
  assert.equal(t.site, 'bilibili');
  const done = await waitTask(c, t.id, (x) => x.status === 'done', 'P2 下载完成');
  await waitFor('界面首行变为完成', () => rowStatusIs(c, 'done'), { timeout: 10000 });
  assert.ok(done.title?.includes('P2'), `任务应是 P2：${done.title}`);
  assert.ok(done.file.includes('P2'), `文件名应带 P2：${done.file}`);
  const file = checkDownloaded(done, DEFAULT_DIR, since, 'bili-p2.mp4', 'B站 P2');
  console.log(`    选集里的 ${items.length} 项: ${items.map((x) => x.title).join(' | ')}\n    文件: ${done.file} (${file.size} 字节)`);
});

test('invalid-dir: 所选目录已失效（被删除或权限被收回）→ 任务失败并说明原因', async (h) => {
  // 上一个用例失败时可能留着没关的弹窗（比如选集窗口），它的遮罩会挡住后面的点击：先把页面复位
  await resetUi(h.c);
  const r = await api.post('/api/download', {
    input: URLS.bili,
    quality: null,
    audio: false,
    outDir: 'content://com.android.externalstorage.documents/tree/primary%3ADownload%2FNO_SUCH_DIR',
    playlistItems: null,
  });
  const t = r.tasks[0];
  const failed = await waitTask(h.c, t.id, (x) => x.status === 'error', '任务失败', 120000);
  assert.match(failed.error, /所选目录/, '失败原因应提示重新选择保存目录');
  // 是目录的问题就不能说成网络问题（两者底层是同一种异常，文案必须分清）
  assert.doesNotMatch(failed.error, /网络错误/, '目录失效不应被说成网络错误');
  // 界面上看得到原因
  await waitFor('失败任务出现在列表首行', () => rowShows(h.c, t), { timeout: 10000 });
  await h.c.tap('.trow .t-title');
  await waitFor('详情抽屉打开', () => h.c.evaluate(`!!document.querySelector('.ant-drawer-open')`), { timeout: 8000 });
  const text = await h.c.evaluate(`document.querySelector('.ant-drawer-open').textContent`);
  assert.ok(text.includes('所选目录'), '详情抽屉里应写明原因:\n' + text.slice(0, 400));
  await h.c.tap('.ant-drawer-open .ant-drawer-close');
  await waitFor('详情抽屉关闭', () => h.c.evaluate(`!document.querySelector('.ant-drawer-open')`), { timeout: 8000 });
  console.log(`    提示: ${failed.error}`);
});

test('restart-resume-hls: 下载途中应用被关闭 → 重新打开后任务显示为暂停 → 可恢复并完成', async (h) => {
  const hls = h.hls;
  hls.slowDown(400, '/ts-plain/seg'); // 放慢分段响应，留出关闭应用的时间窗口
  try {
    let c = h.c;
    await resetUi(c);
    const since = deviceNow();
    const t = await submitAndCatch(c, { url: hls.url('ts-plain/index.m3u8'), timeout: 30000 });
    await waitTask(c, t.id, (x) => x.status === 'running' && x.percent >= 20, '下载进度 ≥ 20%', 120000);

    await relaunch(h); // 强制结束应用再重新打开
    c = h.c; // 重启后必须用新连接
    const paused = await waitTask(c, t.id, (x) => x.status === 'paused', '重启后任务变为暂停', 30000);
    assert.ok(paused.log.some((l) => l.includes('应用重启')), '日志里应说明是应用重启导致的中断');
    await waitFor('界面首行显示暂停', () => rowStatusIs(c, 'paused'), { timeout: 10000 });
    hls.slowDown(0);

    await c.tap('.trow [data-act="retry"]');
    const done = await waitTask(c, t.id, (x) => x.status === 'done', '恢复后下载完成');
    assert.ok(done.log.join('\n').includes('分段从断点继续'), '应从断点继续而不是从头下载');
    const file = checkDownloaded(done, DEFAULT_DIR, since, 'hls-restart.mp4', 'HLS（重启恢复后）');
    assertSameVideo(file.local, path.join(hls.ref, 'ts-plain.mp4'), 'HLS（重启恢复后）vs ffmpeg 参考');
    assertAVSync(file.local, path.join(hls.ref, 'ts-plain.mp4'), 'HLS（重启恢复后）：音画起点关系');
    console.log(`    文件: ${done.file} (${file.size} 字节)`);
  } finally {
    hls.slowDown(0);
  }
});

/* ------------------------------------------------- 续传 / 并行 / 设置（真实界面） -- */

test('hls-expiring: 分段地址过期（HTTP 403）→ 刷新播放列表换新地址接着下，已下好的分段不重来', async (h) => {
  const hls = h.hls;
  const { done, file } = await downloadThroughUi(h, hls.url('expiring/index.m3u8'), 'hls-expiring.mp4', 'HLS 地址过期');
  const log = (done.log || []).join('\n');
  assert.match(log, /分段地址已过期（HTTP 403），已刷新播放列表，从第 3 段继续/, '日志应说明刷新了播放列表并接着下:\n' + log);
  assert.ok(hls.expiring.rejected >= 1, '服务器应回过 403');
  // 已经下好的分段没有被重复下载：每一段只成功下发了一次
  const counts = {};
  for (const s of hls.expiring.servedSegments) counts[s] = (counts[s] || 0) + 1;
  assert.deepEqual(counts, { 'seg000.ts': 1, 'seg001.ts': 1, 'seg002.ts': 1, 'seg003.ts': 1 }, '各分段应各下载一次');
  assertSameVideo(file.local, path.join(hls.ref, 'ts-plain.mp4'), 'HLS（地址过期后继续）vs ffmpeg 参考');
  assertSameAudio(file.local, path.join(hls.ref, 'ts-plain.mp4'), 'HLS（地址过期后继续）：音频');
  const av = assertAVSync(file.local, path.join(hls.ref, 'ts-plain.mp4'), 'HLS（地址过期后继续）：音画起点关系');
  console.log(`    刷新了 ${hls.expiring.playlistFetches - 1} 次播放列表；音画起点：视频比音频${av.mine >= 0 ? '晚' : '早'} ${(Math.abs(av.mine) * 1000).toFixed(1)}ms`);
});

test('hls-fail-retry: 中途某一段一直 403 → 任务失败、已下载的分段保留 → 修好后点「重试」从断点继续并完成', async (h) => {
  const c = h.c;
  const hls = h.hls;
  hls.flaky.broken = true;
  hls.flaky.served.length = 0;
  await resetUi(c);
  try {
    const t = await submitAndCatch(c, { url: hls.url('flaky/index.m3u8'), timeout: 30000 });
    const failed = await waitTask(c, t.id, (x) => x.status === 'error', '分段一直被拒 → 任务失败', 120000);
    assert.match(failed.error, /403/, '失败原因应提到 HTTP 403: ' + failed.error);
    assert.match(failed.log.join('\n'), /已下载的部分已保留/, '应告诉用户重试会接着下:\n' + failed.log.join('\n'));
    assert.match(partsListing(t.id), /stream\.ts/, '失败后应保留已下载的分段');
    // 失败前已下好前两段
    assert.deepEqual(hls.flaky.served, ['seg000.ts', 'seg001.ts']);
    await waitFor('界面首行显示失败', () => rowStatusIs(c, 'error'), { timeout: 10000 });

    // 服务器修好了 → 真实点击「重试」
    hls.flaky.broken = false;
    await c.tap('.trow [data-act="retry"]');
    const done = await waitTask(c, t.id, (x) => x.status === 'done', '重试后下载完成', 180000);
    assert.match(done.log.join('\n'), /分段从断点继续下载（已完成 2 段，共 4 段）/);
    // 前两段没有重新下载：整个过程中每一段只成功下发了一次
    assert.deepEqual(hls.flaky.served, ['seg000.ts', 'seg001.ts', 'seg002.ts', 'seg003.ts']);
    assert.equal(partsListing(t.id).trim(), '', '完成后应清理缓存');
    const file = checkDownloaded(done, DEFAULT_DIR, 0, 'hls-retried.mp4', 'HLS（失败后重试）');
    assertSameVideo(file.local, path.join(hls.ref, 'ts-plain.mp4'), 'HLS（失败后重试）vs ffmpeg 参考');
    assertAVSync(file.local, path.join(hls.ref, 'ts-plain.mp4'), 'HLS（失败后重试）：音画起点关系');
    console.log(`    失败原因: ${failed.error}\n    文件: ${done.file} (${file.size} 字节)`);
  } finally {
    hls.flaky.broken = true;
  }
});

/** 提交 [urls]，持续观察任务状态直到全部结束；返回 { tasks, maxRunning } */
async function submitAndWait(h, urls, desc, timeout = 240000) {
  const r = await api.post('/api/download', { input: urls.join('\n'), quality: null, audio: false, outDir: null, playlistItems: null });
  assert.ok(Array.isArray(r.tasks), `${desc}: 提交失败: ${JSON.stringify(r)}`);
  assert.equal(r.tasks.length, urls.length, `${desc}: 应创建 ${urls.length} 个任务`);
  const ids = new Set(r.tasks.map((t) => t.id));
  let maxRunning = 0;
  let final = [];
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const mine = (await api.get('/api/tasks')).tasks.filter((x) => ids.has(x.id));
    maxRunning = Math.max(maxRunning, mine.filter((x) => x.status === 'running').length);
    if (mine.length === ids.size && mine.every((x) => x.status === 'done' || x.status === 'error')) {
      final = mine;
      break;
    }
    await sleep(120);
  }
  assert.equal(final.length, urls.length, `${desc}: 任务没能在 ${timeout / 1000}s 内结束`);
  for (const t of final) assert.equal(t.status, 'done', `${desc}: 任务 ${t.url} 失败: ${t.error}\n${(t.log || []).join('\n')}`);
  return { tasks: final, maxRunning };
}

test('parallel-tasks: 一次提交 4 个任务 → 默认 3 个同时下载（第 4 个排队），各自完成、文件正确', async (h) => {
  const hls = h.hls;
  hls.slowDown(600, '/'); // 每个请求都慢一点，保证任务之间确实重叠
  try {
    const { tasks, maxRunning } = await submitAndWait(
      h,
      [hls.url('ts-plain/index.m3u8'), hls.url('fmp4/index.m3u8'), hls.url('ts-aes/index.m3u8'), hls.url('expiring/index.m3u8')],
      '并行下载',
    );
    assert.equal(maxRunning, 3, `最多应同时下载 3 个（默认值），实际观察到 ${maxRunning}`);
    // 四个任务都出现在界面上，并且都是完成状态
    await waitFor('界面上这 4 个任务都显示为完成', async () => {
      const rows = await h.c.evaluate(`[...document.querySelectorAll('.trow')].map((r) => ({ status: [...r.classList].find((k) => k !== 'trow'), text: r.textContent }))`);
      return tasks.every((t) => rows.some((r) => r.status === 'done' && [t.url, t.title, t.file].filter(Boolean).some((s) => r.text.includes(s))));
    }, { timeout: 10000 });
    const files = [];
    for (const t of tasks) {
      const local = `parallel-${t.id}.mp4`;
      const ref = t.url.includes('/fmp4/') ? 'fmp4.mp4' : t.url.includes('/ts-aes/') ? 'ts-aes.mp4' : 'ts-plain.mp4';
      const pulled = pullExact(t.file, local);
      assert.ok(pulled, `并行下载的文件应落盘: ${t.file}`);
      assert.equal(pulled.size, t.sizeBytes);
      assertSameVideo(pulled.local, path.join(hls.ref, ref), `并行下载 ${new URL(t.url).pathname} vs ffmpeg 参考`);
      files.push(`${new URL(t.url).pathname} → ${path.basename(t.file)}`);
    }
    console.log(`    同时下载的峰值: ${maxRunning} 个\n    ${files.join('\n    ')}`);
  } finally {
    hls.slowDown(0);
  }
});

test('parallel-setting: 设置里把「同时下载任务数」调成 1 → 一个下完再下一个；再调回 3', async (h) => {
  const c = h.c;
  const hls = h.hls;
  await resetUi(c);
  assert.equal((await api.get('/api/config')).maxParallel, 3, '默认应同时下载 3 个');
  await c.tap('#gear');
  await waitFor('设置面板展开', () => c.evaluate(`document.querySelector('#settings').classList.contains('open')`), { timeout: 8000 });
  await waitFor('设置里出现「同时下载任务数」', () => c.evaluate(`!!document.querySelector('#parallel .ant-segmented-item')`), { timeout: 5000 });
  assert.match(await c.evaluate(`document.querySelector('#parallel').parentElement.textContent`), /同时下载任务数/);

  // 真实点击「1 个」
  await c.tap('#parallel .ant-segmented-item:nth-of-type(1)');
  await waitFor('服务端收到 maxParallel=1', async () => (await api.get('/api/config')).maxParallel === 1, { timeout: 5000 });
  hls.slowDown(700, '/');
  try {
    const { maxRunning } = await submitAndWait(h, [hls.url('ts-plain/index.m3u8'), hls.url('fmp4/index.m3u8')], '串行下载');
    assert.equal(maxRunning, 1, `调成 1 之后不应同时下载两个，实际观察到 ${maxRunning}`);
  } finally {
    hls.slowDown(0);
  }

  // 真实点击「3 个」调回去
  await c.tap('#parallel .ant-segmented-item:nth-of-type(3)');
  await waitFor('服务端收到 maxParallel=3', async () => (await api.get('/api/config')).maxParallel === 3, { timeout: 5000 });
  // 切到英文，控件文案跟着变
  await c.tapText('English');
  await waitFor('英文下显示 Downloads at once', () => c.evaluate(`document.querySelector('#parallel').parentElement.textContent.includes('Downloads at once')`), { timeout: 8000 });
  await c.tapText('中文');
  await waitFor('界面切回中文', () => c.evaluate(`document.querySelector('#parallel').parentElement.textContent.includes('同时下载任务数')`), { timeout: 8000 });
});

test('parallel-mixed: 两个 YouTube + 一个 HLS 同时下载，各自完成且内容正确', async (h) => {
  const hls = h.hls;
  const since = deviceNow();
  const urls = [URLS.yt, process.env.VD_E2E_YT_ALT || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', hls.url('ts-plain/index.m3u8')];
  const { tasks, maxRunning } = await submitAndWait(h, urls, '混合并行', 600000);
  assert.equal(maxRunning, 3, `三个任务应同时下载，实际观察到 ${maxRunning}`);
  for (const t of tasks) {
    const local = `mixed-${t.id}.mp4`;
    const pulled = pullExact(t.file, local);
    assert.ok(pulled, `文件应落盘: ${t.file}`);
    assert.equal(pulled.size, t.sizeBytes);
    assert.equal(decodeErrors(pulled.local), '', `${t.site}: 整段解码不应有错误`);
  }
  console.log(`    同时下载的峰值: ${maxRunning} 个\n    ${tasks.map((t) => `${t.site}: ${t.file} (${t.sizeBytes} 字节)`).join('\n    ')}`);
});

test('pause-resume-bili: B站下载中途点「暂停」→ 点「恢复」从断点继续并完成', async (h) => {
  const c = h.c;
  await resetUi(c);
  const since = deviceNow();
  // 52MB 的视频在这个网络下要下一分多钟，中途有足够的时间暂停
  const t = await submitAndCatch(c, { url: URLS.bili });
  const running = await waitTask(c, t.id, (x) => x.status === 'running' && x.percent >= 10 && x.percent < 90, '下载进度在 10%–90% 之间', 180000);
  assert.equal(running.stage, '下载中', '下载阶段界面应显示「下载中」');
  await c.tap('.trow [data-act="pause"]');
  const paused = await waitTask(c, t.id, (x) => x.status === 'paused', '任务变为暂停', 30000);
  assert.ok(paused.downloaded > 0, '暂停时应已有进度');
  assert.match(partsListing(t.id), /data\.mp4\.part/, `暂停后应保留断点文件:\n${partsListing(t.id)}`);
  await c.tap('.trow [data-act="retry"]');
  const done = await waitTask(c, t.id, (x) => x.status === 'done', '恢复后下载完成', 300000);
  assert.match(done.log.join('\n'), /从断点继续（已有 \d+ MB）/, `恢复时应接着上次的断点继续:\n${done.log.join('\n')}`);
  assert.equal(partsListing(t.id).trim(), '', '完成后应清理缓存');
  const file = checkDownloaded(done, DEFAULT_DIR, since, 'bili-resumed.mp4', 'B站（恢复后）');
  console.log(`    ${done.log.join('\n')}\n    文件: ${done.file} (${file.size} 字节)`);
});

test('download-yt-audio: 打开「仅音频」→ YouTube 保存为 m4a，内容是 AAC 音频', async (h) => {
  const c = h.c;
  await resetUi(c);
  const since = deviceNow();
  await typeInto(c, URLS.yt);
  await c.tap('#audio');
  await waitFor('「仅音频」开关已打开', () => c.evaluate(`document.querySelector('#audio').getAttribute('aria-checked') === 'true'`), { timeout: 5000 });
  const before = await taskIds();
  await c.tap('#btn');
  const t = await waitNewTask(before, 30000);
  const done = await waitTask(c, t.id, (x) => x.status === 'done', '仅音频任务完成', 300000);
  assert.ok(done.file.endsWith('.m4a'), `仅音频应保存为 m4a: ${done.file}`);
  const fresh = filesNewerThan(DEFAULT_DIR, since - 1);
  const pulled = pullExact(done.file, 'yt-audio.m4a');
  assert.ok(pulled && fresh.includes(`${DEFAULT_DIR}/${pulled.name}`), `新文件应写入 ${DEFAULT_DIR}:\n  新文件: ${JSON.stringify(fresh)}`);
  assert.equal(pulled.size, done.sizeBytes, '文件大小应与任务记录一致');
  const info = mediaInfo(pulled.local);
  assert.match(info, /Audio: aac/, '应为 AAC 音频:\n' + info);
  assert.doesNotMatch(info, /Video:/, '不应有视频流:\n' + info);
  assert.equal(decodeErrors(pulled.local), '', '整段解码不应有错误');
  console.log(`    文件: ${done.file} (${pulled.size} 字节) ${info.match(/Duration: [^,]+/)?.[0]}`);
});
/* ----------------------------------------------------------------- 主流程 -- */
async function main() {
  if (argv.includes('--list')) {
    for (const t of tests) console.log('  ' + t.name);
    return 0;
  }
  const selected = tests.filter((t) => only.length === 0 || only.some((k) => t.name.startsWith(k)));
  await startApp();
  const h = { c: await connect() };
  // HLS 相关用例需要电脑上的本地测试源（模拟器通过 10.0.2.2 访问）
  if (selected.some((t) => t.name.includes('hls') || t.name.startsWith('parallel'))) h.hls = await startHlsServer();

  let failed = 0;
  const results = [];
  for (const t of selected) {
    process.stdout.write(`\n▶ ${t.name}\n`);
    const t0 = Date.now();
    try {
      await t.fn(h);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      results.push({ name: t.name, ok: true });
      console.log(`  ✔ PASS (${secs}s)`);
    } catch (e) {
      failed++;
      const shot = screenshot(`FAIL-${t.name.split(':')[0]}`);
      results.push({ name: t.name, ok: false, error: e.message });
      console.log(`  ✖ FAIL  [截图 ${shot}]\n${String(e.message).split('\n').map((l) => '      ' + l).join('\n')}`);
      const errs = h.c.console.errors;
      if (errs.length) console.log('    控制台错误:\n      ' + errs.join('\n      '));
      // 最近几次点击：想点什么、实际点到了哪里
      const taps = h.c.taps.slice(-5).map((k) => `${k.label} @${k.css.join(',')} ${k.landed ? '✓' : '✗ ' + JSON.stringify(k.clicks)}`);
      if (taps.length) console.log('    最近的点击:\n      ' + taps.join('\n      '));
    }
    // 上一个用例半路失败时，系统界面（文件夹选择器、授权框）或页面上的弹窗可能还开着，会挡住后面所有的点击
    await recoverUi(h.c).catch(() => {});
  }
  h.c.ws.close();
  await h.hls?.close();
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} 通过${failed ? `，${failed} 个失败` : ''}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(2);
  },
);
