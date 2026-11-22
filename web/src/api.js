// 后端 API 封装
const post = (p, body) =>
  fetch(p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json());

export const api = {
  parse: (input) => post('/api/parse', { input }),
  download: (payload) => post('/api/download', payload),
  retry: (id) => post('/api/retry', { id }),
  reveal: (path) => post('/api/reveal', { path }),
  pickDir: () => post('/api/pick-dir', {}),
  proxyTest: (proxy) => post('/api/proxy-test', { proxy }),
  saveProxy: (proxy) => post('/api/config', { proxy }),
  saveSessdata: (bilibiliSessdata) => post('/api/config', { bilibiliSessdata }),
  getConfig: () => fetch('/api/config').then((r) => r.json()),
  getTasks: () => fetch('/api/tasks').then((r) => r.json()),
  fsList: (dir) => fetch('/api/fs/list' + (dir ? '?dir=' + encodeURIComponent(dir) : '')).then((r) => r.json()),
};

export function midTrunc(name, head = 24, tail = 14) {
  return name.length > head + tail + 1 ? name.slice(0, head) + ' … ' + name.slice(-tail) : name;
}

export const SITE_LABEL = { youtube: 'YouTube', douyin: '抖音', bilibili: 'B站', xiaohongshu: '小红书' };
