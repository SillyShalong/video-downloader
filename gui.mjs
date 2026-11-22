#!/usr/bin/env node
// Web 模式 GUI 入口（无 Electron 时的备选）：本地服务 + Edge 应用窗口
// 首选方式是 Electron: npm start
// 用法: node gui.mjs [--no-open] [--port=8321]
import { spawn } from 'node:child_process';
import { startServer } from './src/start-server.mjs';
import { findEdge } from './src/headless-edge.mjs';

const args = new Set(process.argv.slice(2));
const noOpen = args.has('--no-open');
const portArg = [...args].find((a) => a.startsWith('--port='));
const preferredPort = portArg ? Number(portArg.split('=')[1]) : 8321;

const { url } = await startServer(preferredPort);
console.log(`Video Downloader GUI 已启动: ${url}`);
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
