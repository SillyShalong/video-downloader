#!/usr/bin/env node
// Web 模式 GUI 入口（无 Electron 时的备选）：本地服务 + Edge 应用窗口
// 首选方式是 Electron: npm start
// 用法: node gui.mjs [--no-open] [--lan] [--port=8321]
//   --lan  绑定 0.0.0.0，手机/平板可经局域网访问（远程模式/App 用）
import { spawn } from 'node:child_process';
import os from 'node:os';
import { startServer } from './src/start-server.mjs';
import { findEdge } from './src/headless-edge.mjs';

const args = new Set(process.argv.slice(2));
const noOpen = args.has('--no-open');
const lan = args.has('--lan');
const portArg = [...args].find((a) => a.startsWith('--port='));
const preferredPort = portArg ? Number(portArg.split('=')[1]) : 8321;
const host = lan ? '0.0.0.0' : '127.0.0.1';

const { url } = await startServer(preferredPort, {}, host);
console.log(`Video Downloader GUI 已启动: ${url}`);

if (lan) {
  // 打印局域网地址：手机浏览器直接访问，或填入 App 的「远程模式 · 服务器地址」
  const nets = os.networkInterfaces();
  const ips = Object.values(nets)
    .flat()
    .filter((n) => n?.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
  if (ips.length > 0) {
    console.log('局域网访问（手机/平板）:');
    for (const ip of ips) console.log(`  http://${ip}:${preferredPort}`);
    console.log('⚠ 局域网内任何设备都可访问此服务，请确保网络可信');
  } else {
    console.log('⚠ 未发现局域网 IPv4 地址');
  }
}
console.log('按 Ctrl+C 退出');

if (!noOpen) {
  const edge = findEdge();
  if (edge) {
    // --app: 独立窗口形态，看起来像原生应用
    spawn(edge, [`--app=${url}`, '--window-size=1000,820'], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }
}
