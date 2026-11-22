// 后端 API 封装
// 远程模式：设置面板填「服务器地址」后（存 localStorage.vd.server），
// 所有请求与 SSE 走该地址（手机/PWA 操控桌面服务）；桌面本机运行为空 = 同源。
export const serverBase = () => {
  const s = localStorage.getItem('vd.server') || '';
  return s.replace(/\/+$/, '');
};

const post = (p, body) =>
  fetch(serverBase() + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json());

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
  pickDir: () => post('/api/pick-dir', {}),
  proxyTest: (proxy) => post('/api/proxy-test', { proxy }),
  saveProxy: (proxy) => post('/api/config', { proxy }),
  saveSessdata: (bilibiliSessdata) => post('/api/config', { bilibiliSessdata }),
  saveHlsSites: (hlsSites) => post('/api/config', { hlsSites }),
  getConfig: () => fetch(serverBase() + '/api/config').then((r) => r.json()),
  getTasks: () => fetch(serverBase() + '/api/tasks').then((r) => r.json()),
  fsList: (dir) =>
    fetch(serverBase() + '/api/fs/list' + (dir ? '?dir=' + encodeURIComponent(dir) : '')).then((r) => r.json()),
};

export function midTrunc(name, head = 24, tail = 14) {
  return name.length > head + tail + 1 ? name.slice(0, head) + ' … ' + name.slice(-tail) : name;
}

export const SITE_LABEL = { youtube: 'YouTube', douyin: '抖音', bilibili: 'B站', xiaohongshu: '小红书' };

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
