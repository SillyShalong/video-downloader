// 平台抽象层：所有 OS 差异收敛在这里（win32 / darwin / linux）
// 桌面三平台共用同一份 Electron + Node core，本模块是唯一分叉点。
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';

/* ---------- 二进制名 ---------- */
export const ytDlpName = (plat = process.platform) => (plat === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
export const ffmpegName = (plat = process.platform) => (plat === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
export const denoName = (plat = process.platform) => (plat === 'win32' ? 'deno.exe' : 'deno');

/* ---------- Chromium 候选（抖音/小红书引擎的无头浏览器） ---------- */
export function chromiumCandidates(env = process.env) {
  const home = os.homedir();
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  if (IS_WIN) {
    return [
      env.EDGE_PATH,
      env.CHROMIUM_PATH,
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      path.join(local, 'Google\\Chrome\\Application\\chrome.exe'),
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ].filter(Boolean);
  }
  if (IS_MAC) {
    return [
      env.EDGE_PATH,
      env.CHROMIUM_PATH,
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ].filter(Boolean);
  }
  return [
    env.EDGE_PATH,
    env.CHROMIUM_PATH,
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
}

export function findChromium() {
  return chromiumCandidates().find((p) => existsSync(p)) ?? null;
}

/* ---------- 打开文件 / 资源管理器定位 ---------- */
/** 返回 { file, args, verbatim }，spawn(file, args, { detached:true, stdio:'ignore', windowsVerbatimArguments: verbatim }) */
export function revealCommand(p, isDir, platform = process.platform) {
  if (platform === 'win32') {
    // explorer 只认 /select,"路径"（引号仅包路径；含空格时若整段被引号包裹会退化成打开默认视图）
    return { file: 'explorer.exe', args: [isDir ? `"${p}"` : `/select,"${p}"`], verbatim: true };
  }
  if (platform === 'darwin') {
    return { file: 'open', args: ['-R', p], verbatim: false }; // Finder 中定位
  }
  return { file: 'xdg-open', args: [path.dirname(p)], verbatim: false }; // 打开所在目录
}

export function openCommand(p, platform = process.platform) {
  if (platform === 'win32') {
    // cmd /c start "" "路径"：start 首个引号参数是标题占位
    return { file: 'cmd', args: ['/c', 'start', '', p], verbatim: false };
  }
  if (platform === 'darwin') return { file: 'open', args: [p], verbatim: false };
  return { file: 'xdg-open', args: [p], verbatim: false };
}

/* ---------- 进程树击杀（暂停/终止） ---------- */
export function killTree(child) {
  if (!child.pid) return;
  try {
    if (IS_WIN) {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' });
    } else {
      // TERM 主进程 + TERM 子进程（合并阶段的 ffmpeg），2s 后 KILL 兜底
      try { process.kill(child.pid, 'SIGTERM'); } catch {}
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      try { spawnSync('pkill', ['-TERM', '-P', String(child.pid)], { stdio: 'ignore' }); } catch {}
      setTimeout(() => {
        try { process.kill(child.pid, 'SIGKILL'); } catch {}
      }, 2000).unref();
    }
  } catch {}
}

/* ---------- 根视图（目录浏览器「此电脑」层） ---------- */
let winDrivesCache = null;

export function listRoots() {
  const home = os.homedir();
  const out = [];
  if (IS_WIN) {
    if (!winDrivesCache) {
      try {
        const r = spawnSync(
          'powershell',
          ['-NoProfile', '-Command', '(Get-PSDrive -PSProvider FileSystem).Root'],
          { encoding: 'utf8', windowsHide: true, timeout: 8000 },
        );
        winDrivesCache = (r.stdout || '')
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => /^[A-Z]:\\?$/i.test(s));
      } catch {}
      if (!winDrivesCache || winDrivesCache.length === 0) winDrivesCache = ['C:\\'];
    }
    for (const d of winDrivesCache) out.push({ name: d, path: d });
  } else if (IS_MAC) {
    try {
      for (const v of readdirSync('/Volumes')) out.push({ name: v, path: path.join('/Volumes', v) });
    } catch {}
  } else {
    // Linux：根目录 + 常见挂载点
    out.push({ name: '/', path: '/' });
    for (const base of ['/media', '/mnt']) {
      try {
        for (const m of readdirSync(base)) out.push({ name: `${base}/${m}`, path: path.join(base, m) });
      } catch {}
    }
  }
  return [{ name: '主目录', path: home }, ...out];
}
