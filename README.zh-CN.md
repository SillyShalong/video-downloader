<div align="center">

<img src="docs/icon.png" width="96" alt="Video Downloader" />

# 🎬 Video Downloader

**一个界面精致的视频下载工具 —— YouTube · 抖音 · 哔哩哔哩 · 小红书 · 千余站点**

[![Platform](https://img.shields.io/badge/platform-Windows-blue)](https://github.com/SillyShalong/video-downloader/releases)
[![Electron](https://img.shields.io/badge/Electron-45-9feaf9?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white)](https://react.dev/)
[![Ant Design](https://img.shields.io/badge/Ant_Design-6-1677ff?logo=antdesign&logoColor=white)](https://ant.design/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-63%20%E9%A1%B9-brightgreen)](#-自动化测试)

**桌面应用 + CLI + 安卓** · 清晰度自选 · 实时速度 · 暂停/终止 · 下载历史 · H.264 兼容 · 中英双语

[下载安装包](#-下载安装) · [快速上手](#-快速上手) · [开发指南](#-开发) · [English](README.md)

</div>

---

![screenshot](docs/screenshot.png)

## ✨ 特性

| | | |
|---|---|---|
| 🌍 **千余站点** | YouTube（含 Shorts/播放列表）、抖音、哔哩哔哩、小红书 + yt-dlp 支持的全部站点 | 粘贴链接或**整段分享口令**，自动识别站点 |
| 🎞 **清晰度自选** | 最佳 / 1080p / 720p / 540p / 360p | B 站支持 SESSDATA 登录解锁高清晰度 |
| 📋 **多视频源选择** | 播放列表/合集/频道自动检测 | 勾选想下的视频，只下载选中的 |
| 🗂 **下载历史** | 元数据持久化（原始链接/目标路径/大小） | 紧凑列表 + 详情抽屉，可删除单条记录 |
| 🛡 **兼容性优先** | 全站锁定 H.264 + AAC | Windows 自带播放器直接可放，不黑屏 |
| 🌐 **代理支持** | HTTP / SOCKS5，一键测试连通 | 抖音/小红书智能直连不走代理 |
| 🔁 **稳定下载** | 瞬时错误（403/超时）自动重试 | 手动暂停 / 终止 / 恢复（断点续传） |
| 📱 **安卓应用** | B站独立引擎 + 远程模式 | 同一套 UI，局域网操控桌面端 |
| 🌏 **中英双语** | ⚙ 设置中一键切换语言 | 所有按钮/提示/状态文案均已翻译 |
| 🖥 **双形态** | Electron 桌面应用（原生目录选择框） | CLI 命令行（脚本友好） |

## 📥 下载安装

**普通用户（推荐）**：到 [Releases](https://github.com/SillyShalong/video-downloader/releases) 下载最新版：

- `VideoDownloader-Setup-x.y.z-x64.exe` — Windows 安装包（可选安装目录、创建桌面快捷方式）
- `VideoDownloader-Portable-x.y.z-x64.exe` — Windows 便携版（免安装，双击即用）
- `VideoDownloader-Android-vX.Y.Z.apk` — 安卓应用（B站独立下载 + 远程模式）

开箱即用，无需安装 Node.js / Python，yt-dlp、ffmpeg、deno 全部内置。

**从源码运行**：

```bash
git clone https://github.com/SillyShalong/video-downloader.git
cd video-downloader
npm install          # 安装依赖
npm run setup        # 下载 yt-dlp / ffmpeg / deno 到 bin/
npm run build:web    # 构建前端
npm start            # 启动桌面应用
```

## 🚀 快速上手

### GUI

1. 粘贴视频链接或整段分享口令（支持一次多条、混合站点）
2. 选择清晰度 → 点「开始下载」
3. 播放列表/合集会弹出**多视频源选择**（全选/全不选/按条勾选，显示时长）
4. 任务列表实时显示进度/速度，点击行查看详情

### CLI

```bash
node cli.mjs "https://www.youtube.com/watch?v=xxxx"          # YouTube
node cli.mjs "抖音分享口令整段直接粘贴"                        # 抖音
node cli.mjs "https://www.bilibili.com/video/BV..." -q 1080  # B站 1080p
node cli.mjs --audio "https://youtu.be/xxxx" -o D:/Music      # 仅音频转 mp3
node cli.mjs "https://youtu.be/xxxx" -p http://127.0.0.1:7890 # 走代理
```

### 安卓

- **独立模式**：打开 App → 粘贴 B站链接 → 直接下载到手机
- **远程模式**：桌面端 `node gui.mjs --lan` → App ⚙ 设置 → 填服务器地址

## 🔧 平台说明

| 平台 | 引擎 | 说明 |
|---|---|---|
| YouTube | yt-dlp + deno（解 JS 签名） | 代理生效；DASH 音视频自动合并 |
| 哔哩哔哩 | yt-dlp | 多 P 支持；SESSDATA 解锁 720p+；代理生效 |
| 抖音 | 自研（无头 Edge 页内签名） | 绕过 Argus 风控；无水印；**必须分享链接** |
| 小红书 | 自研（无头 Edge 读页面数据） | **必须 App 分享链接**（裸链接被平台拦截） |
| HLS 流媒体 | 自研（无头 Edge + m3u8 提取） | Cloudflare 防护站点；域名在 `config.json` `hlsSites` 配置 |
| 其他站点 | yt-dlp generic | 自动覆盖（千余站点） |

## 📱 手机 / 平板（远程模式）

Node 引擎无法在手机上原生运行，移动端采用**远程模式**——操控局域网里的桌面服务：

1. 桌面端执行：`node gui.mjs --lan`（打印手机可访问地址）
2. 手机浏览器直接打开（可添加到主屏幕当 PWA），或使用安卓 App

完整功能：提交下载、选清晰度、实时进度/速度、暂停/终止。

## 🧪 自动化测试

```bash
npm test              # 构建前端 + 全量测试
npm run test:gui      # 仅 GUI 回归（无头 Edge 驱动真实页面）
npm run test:network  # 额外启用外网用例
```

63 项测试覆盖：站点识别、分享口令解析、下载参数（H.264 锁定回归）、代理校验、资源管理器定位命令、下载任务全链路（SSE → 落盘）、失败重试/暂停/终止、下载历史持久化、多视频源选择、**防闪烁**（DOM 节点身份断言）、弹窗关闭方式、远程模式连接错误提示。

## 🛠 开发

```
web/src/         React + AntD 前端（Vite，中英双语）
electron/        Electron 主进程（原生对话框、路径）
src/             下载引擎（yt-dlp 封装 / 抖音 / 小红书 / HLS / 任务队列 / SSE）
bin/             yt-dlp · ffmpeg · deno（npm run setup 下载）
android/         Capacitor 安卓工程（同一套 UI + Kotlin 独立 B站引擎）
tests/           node:test 三层测试（单元 / 服务端 / GUI）
```

```bash
npm run dev       # 前端热更新
npm run dist      # 打包 Windows 安装包 + 便携版
npm test          # 全量测试
```

## ❓ FAQ

**下载的视频只有声音没有画面？**
不会。全站锁定 H.264 编码（yt-dlp 默认会选 VP9/AV1，Windows 播放器解不了），无 H.264 源时自动转码。

**B 站只能下 480p？**
游客身份部分视频限 480p。⚙ 设置 → 填 SESSDATA（浏览器 F12 → Cookie）即可解锁。

**下载失败提示 403？**
多为代理出口 IP 变动，内置 3 次自动重试；仍失败可点任务行上的重试按钮。

## 📄 License

[MIT](LICENSE)

---

<div align="center">
⭐ 如果对你有帮助，欢迎 Star 支持一下！
</div>
