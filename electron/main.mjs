// Electron 主进程：启动本地下载服务，窗口加载 GUI 页面
// 注意：路径环境变量必须在动态 import 业务模块【之前】设置——
// ESM 静态 import 会在顶层代码执行前加载模块，config/downloader 顶层就要读这些变量
import { app, BrowserWindow, dialog, shell } from 'electron';
import path from 'node:path';

// 打包版路径解耦：bin 在 resources/bin，配置/历史放用户数据目录，默认下载到系统下载夹
if (app.isPackaged) {
  process.env.VD_BIN_DIR = path.join(process.resourcesPath, 'bin');
  process.env.VD_CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
  process.env.VD_HISTORY_PATH = path.join(app.getPath('userData'), 'history.json');
  process.env.VD_OUT_DIR = path.join(app.getPath('downloads'));
}

let server = null;
let mainWindow = null;

// 单实例：重复打开时聚焦已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

async function main() {
  const { startServer } = await import('../src/start-server.mjs');
  server = await startServer(8321, {
    // 原生目录选择框（「保存到 → 浏览…」）
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
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 外部链接交给系统浏览器，不在应用内开新窗
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  await mainWindow.loadURL(server.url);
  mainWindow.show();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', async () => {
  await server?.close();
});

main().catch((err) => {
  console.error(err);
  app.quit();
});
