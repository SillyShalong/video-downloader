<div align="center">

# 🎬 Video Downloader

**一个界面精致的视频下载工具 —— YouTube · 抖音 · 哔哩哔哩 · 小红书**

[![Platform](https://img.shields.io/badge/platform-Windows-blue)](https://github.com/lijialun/video-downloader/releases)
[![Electron](https://img.shields.io/badge/Electron-45-9feaf9?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white)](https://react.dev/)
[![Ant Design](https://img.shields.io/badge/Ant_Design-6-1677ff?logo=antdesign&logoColor=white)](https://ant.design/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-46%20%E9%A1%B9-brightgreen)](#-自动化测试)

**桌面应用 + 命令行双形态** · 清晰度自选 · 代理支持 · 失败自动重试 · 全程 H.264 兼容编码

[下载安装包](#-下载安装) · [快速上手](#-快速上手) · [开发指南](#-开发)

</div>

---

![screenshot](docs/screenshot.png)

## ✨ 特性

| | | |
|---|---|---|
| 🌍 **四大平台** | YouTube（含 Shorts/播放列表）、抖音、哔哩哔哩、小红书 | 粘贴链接或**整段分享口令**，自动识别站点 |
| 🎞 **清晰度自选** | 最佳 / 1080p / 720p / 540p / 360p | B 站支持 SESSDATA 登录解锁高清晰度 |
| 🛡 **兼容性优先** | 全站锁定 H.264 + AAC | Windows 自带播放器直接可放，不黑屏 |
| 🌐 **代理支持** | HTTP / SOCKS5，一键测试连通 | 抖音/小红书智能直连不走代理 |
| 🔁 **稳定下载** | 瞬时错误（403/超时）自动重试 | 失败任务一键手动重试 |
| 🖥 **双形态** | Electron 桌面应用（原生目录选择框） | CLI 命令行（脚本友好） |
| 🧪 **质量保障** | 46 项自动化测试（单元/服务端/GUI 无头浏览器回归） | 下载中零闪烁（DOM 增量渲染） |

## 📥 下载安装

**普通用户（推荐）**：到 [Releases](https://github.com/lijialun/video-downloader/releases) 下载最新版：

- `VideoDownloader-x.y.z-x64.exe` — 安装包（可选安装目录、创建桌面快捷方式）
- `VideoDownloader-Portable-x.y.z-x64.exe` — 便携版（免安装，双击即用）

开箱即用，无需安装 Node.js / Python，yt-dlp、ffmpeg、deno 全部内置。

**从源码运行**：

```bash
git clone https://github.com/lijialun/video-downloader.git
cd video-downloader
npm install          # 安装依赖（Electron / React / AntD）
npm run setup        # 下载 yt-dlp / ffmpeg / deno 到 bin/
npm run build:web    # 构建前端
npm start            # 启动桌面应用
```

## 🚀 快速上手

### GUI

1. 粘贴视频链接或整段分享口令（支持一次多条、混合站点）
2. 选择清晰度 → 点「开始下载」
3. 任务卡实时显示进度，完成后可「打开文件夹」定位文件

### CLI

```bash
node cli.mjs "https://www.youtube.com/watch?v=xxxx"          # YouTube
node cli.mjs "抖音分享口令整段直接粘贴"                        # 抖音
node cli.mjs "https://www.bilibili.com/video/BV1xx411c7mD" -q 1080   # B站 1080p
node cli.mjs --audio "https://youtu.be/xxxx" -o D:/Music      # 仅音频转 mp3
node cli.mjs "https://youtu.be/xxxx" -p http://127.0.0.1:7890 # 走代理
```

## 🔧 平台说明

| 平台 | 引擎 | 说明 |
|---|---|---|
| YouTube | yt-dlp + deno（解 JS 签名） | 高画质音视频流自动合并；代理生效 |
| 哔哩哔哩 | yt-dlp | 多 P 全下；⚙ 设置里填 SESSDATA 解锁 720p+；代理生效 |
| 抖音 | 自研（无头 Edge 页内签名） | 绕过 Argus 风控，无水印直链；**必须分享链接**；国内直连 |
| 小红书 | 自研（无头 Edge 读页面数据） | **必须 App 分享出来的链接**（裸链接被平台拦截）；国内直连 |

> 💡 为什么抖音/小红书需要「分享」出来的链接？这两个平台的反爬在网关级，
> 直接复制的地址缺少一次性 token，平台会直接拒绝（错误 300031）。

## 🧪 自动化测试

```bash
npm test              # 构建前端 + 全量测试
npm run test:gui      # 仅 GUI 回归（无头 Edge 驱动真实页面）
npm run test:network  # 额外启用外网用例
```

46 项测试覆盖：站点识别、分享口令解析、下载参数构建（H.264 锁定回归）、
代理校验、explorer 定位命令行、下载任务全链路（SSE → 落盘）、
失败重试、**下载中任务卡防闪烁（DOM 节点身份断言）**、弹窗四种关闭方式等。

## 🛠 开发

```
web/src/         React + AntD 前端（Vite）
electron/        Electron 主进程（原生对话框注入）
src/             下载引擎（yt-dlp 封装 / 抖音 / 小红书 / 任务队列 / SSE）
bin/             yt-dlp · ffmpeg · deno（npm run setup 下载）
tests/           node:test 三层测试（单元 / 服务端 / GUI）
```

```bash
npm run dev       # 前端热更新开发
npm run dist      # 打包 Windows 安装包 + 便携版（release/）
```

## ❓ FAQ

**下载的视频只有声音没有画面？**
不会。本工具全站锁定 H.264 编码（yt-dlp 默认会选 VP9/AV1，Windows 播放器解不了），
无 H.264 源时自动转码兜底。

**B 站只能下 480p？**
游客身份部分视频限 480p。⚙ 设置 → 填 SESSDATA（浏览器 F12 → Cookie 里复制）即可解锁。

**下载失败提示 403？**
多为代理出口 IP 变动，本工具已内置 3 次自动重试；仍失败可点任务卡上的「重试」。

## 📄 License

[MIT](LICENSE)

---

<div align="center">
⭐ 如果对你有帮助，欢迎 Star 支持一下！
</div>
