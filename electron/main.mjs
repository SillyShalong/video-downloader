// Electron 主进程：启动本地下载服务，窗口加载 GUI 页面
// 关窗 → 最小化到系统托盘（下载继续）；托盘右键 → 退出才是真关闭
// 路径环境变量必须在动态 import 业务模块【之前】设置
import { app, BrowserWindow, Menu, Tray, dialog, nativeImage, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (app.isPackaged) {
  process.env.VD_BIN_DIR = path.join(process.resourcesPath, 'bin');
  process.env.VD_CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
  process.env.VD_HISTORY_PATH = path.join(app.getPath('userData'), 'history.json');
  process.env.VD_OUT_DIR = path.join(app.getPath('downloads'));
}

let server = null;
let mainWindow = null;
let tray = null;

// 单实例
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

async function main() {
  const { startServer } = await import('../src/start-server.mjs');
  server = await startServer(8321, {
    pickDirectory: async () => {
      const opts = { title: '选择保存目录', properties: ['openDirectory', 'createDirectory'] };
      const r = mainWindow
        ? await dialog.showOpenDialog(mainWindow, opts)
        : await dialog.showOpenDialog(opts);
      return r.canceled ? [] : r.filePaths;
    },
  });
  console.log(`Video Downloader 服务: ${server.url}`);

  await app.whenReady();

  mainWindow = new BrowserWindow({
    width: 1020,
    height: 840,
    minWidth: 720,
    minHeight: 560,
    autoHideMenuBar: true,
    backgroundColor: '#0a0c11',
    title: 'Video Downloader',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 外部链接交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  await mainWindow.loadURL(server.url);
  mainWindow.show();

  // ---- 系统托盘 ----
  const iconPath = path.join(__dirname, '..', 'build', 'icon.ico');
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('Video Downloader');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
      { type: 'separator' },
      { label: '退出（终止下载）', click: () => { app.isQuitting = true; app.quit(); } },
    ]),
  );
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show();
    }
  });

  // ---- 关窗 → 隐藏到托盘（不退出，下载继续） ----
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      tray?.displayBalloon?.({
        iconType: 'info',
        title: 'Video Downloader',
        content: '已最小化到托盘，下载任务继续。右键托盘图标退出。',
      });
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 关窗不退出（最小化到托盘）
app.on('window-all-closed', () => {
  // 留在托盘
});

// 真正退出前：保存任务状态 → 关服务
app.on('before-quit', async () => {
  app.isQuitting = true;
  try {
    server?.saveActiveTasks?.();
  } catch {}
  await server?.close();
  tray?.destroy();
});

main().catch((err) => {
  console.error(err);
  app.quit();
});
