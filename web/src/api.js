// 后端 API 封装
// 远程模式：设置面板填「服务器地址」后（存 localStorage.vd.server），
// 所有请求与 SSE 走该地址（手机/PWA 操控桌面服务）；桌面本机运行为空 = 同源。
export const serverBase = () => {
  const s = localStorage.getItem('vd.server') || '';
  return s.replace(/\/+$/, '');
};

/**
 * 解析接口响应。
 * HTTP 错误且响应体里有 {error} 文案时原样返回（调用方按 r.error 处理）；
 * 响应不是 JSON（比如服务没起来时返回的错误页）则抛出带状态码的异常，不让它变成一个 undefined 悄悄溜过去。
 */
async function parse(r) {
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = null;
  }
  if (!r.ok && !data) {
    const err = new Error(`服务器返回 HTTP ${r.status}${text ? `：${text.slice(0, 120)}` : ''}`);
    err.status = r.status;
    throw err;
  }
  return data ?? {};
}

const post = async (p, body) =>
  parse(
    await fetch(serverBase() + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }),
  );

const get = async (p) => parse(await fetch(serverBase() + p));

export const api = {
  parse: (input) => post('/api/parse', { input }),
  inspect: (input) => post('/api/inspect', { input }),
  download: (payload) => post('/api/download', payload),
  retry: (id) => post('/api/retry', { id }),
  deleteHistory: (id) => post('/api/history/delete', { id }),
  pause: (id) => post('/api/pause', { id }),
  cancel: (id) => post('/api/cancel', { id }),
  openFile: (path) => post('/api/open', { path }),
  reveal: (path) => post('/api/reveal', { path }),
  // outDir：当前保存目录。安卓端据此决定系统选择器打开时停在哪（当前目录里）
  pickDir: (outDir) => post('/api/pick-dir', { outDir: outDir || null }),
  proxyTest: (proxy) => post('/api/proxy-test', { proxy }),
  saveProxy: (proxy) => post('/api/config', { proxy }),
  saveSessdata: (bilibiliSessdata) => post('/api/config', { bilibiliSessdata }),
  saveHlsSites: (hlsSites) => post('/api/config', { hlsSites }),
  getConfig: () => get('/api/config'),
  getTasks: () => get('/api/tasks'),
  fsList: (dir) => get('/api/fs/list' + (dir ? '?dir=' + encodeURIComponent(dir) : '')),
};

export function midTrunc(name, head = 24, tail = 14) {
  return name.length > head + tail + 1 ? name.slice(0, head) + ' … ' + name.slice(-tail) : name;
}

export const SITE_LABEL = { youtube: 'YouTube', douyin: '抖音', bilibili: 'B站', xiaohongshu: '小红书', 'hls-generic': 'HLS' };

export function fmtSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let v = bytesPerSec;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function fmtBytes(n) {
  if (!n || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function fmtEta(sec) {
  if (sec == null || sec < 0 || !Number.isFinite(sec)) return '';
  const s = Math.round(sec);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60}秒`;
  return `${Math.floor(m / 60)}时${m % 60}分`;
}
