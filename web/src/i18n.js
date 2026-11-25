// 轻量 i18n：零依赖，中/英双语，语言偏好存 localStorage
const PACKS = {
  'zh-CN': {
    subtitle: 'YouTube · 抖音 · B站 · 小红书 · 更多站点',
    subtitleAndroid: 'YouTube · B站 · HLS 流媒体 · 独立运行',
    inputLabel: '视频链接 / 分享口令（支持多条，混合站点）',
    inputPlaceholder: '粘贴视频链接，或整段抖音/小红书分享口令（自动识别其中的链接）\n支持一次粘贴多条，Ctrl+Enter 快速开始',
    quality: '清晰度',
    format: '格式',
    audioOnly: '仅音频',
    saveTo: '保存到',
    browse: '浏览…',
    reset: '重置',
    startDownload: '开始下载',
    inspecting: '探测中…',
    tasks: '下载任务',
    total: '累计 {n} 个 · {size}',
    noTasks: '还没有任务 —— 粘贴链接，按 Ctrl+Enter 快速开始',
    noTasksPre: '还没有任务 —— 粘贴链接，按 ',
    noTasksPost: ' 快速开始',
    noLink: '未识别到链接',
    connErr: '无法连接服务器，请检查远程模式设置',
    // status
    stQueued: '排队', stRunning: '下载', stDone: '完成', stError: '失败', stPaused: '暂停', stCancelled: '终止',
    // actions
    pause: '暂停', cancel: '终止', resume: '恢复', retry: '重试',
    openFile: '打开文件', openFolder: '打开文件夹', copyPath: '复制路径', delete: '删除',
    copied: '已复制',
    // settings
    settings: '设置',
    proxyTitle: '网络代理（HTTP / SOCKS5）',
    proxyPlaceholder: 'http://127.0.0.1:7890 或 socks5://127.0.0.1:1080',
    test: '测试', save: '保存',
    proxyNote: '仅对 YouTube 等 yt-dlp 站点生效；抖音/小红书为国内直连。留空即不使用代理。',
    sessdataTitle: '哔哩哔哩 登录（SESSDATA，可选）',
    sessdataPlaceholder: '粘贴浏览器 Cookie 中的 SESSDATA 值，解锁 720p 及以上清晰度',
    sessdataNote: '获取：B 站网页版登录 → F12 → 应用 → Cookie → 复制 SESSDATA 的值。',
    remoteTitle: '远程模式 · 服务器地址（手机/平板用）',
    remotePlaceholder: 'http://192.168.1.100:8321 （桌面端 node gui.mjs --lan 显示的地址）',
    remoteNote: '安卓 App / 手机浏览器（PWA）连桌面服务时填；桌面本机使用请留空。',
    hlsTitle: 'HLS 流媒体站点（Cloudflare 防护，每行一个域名）',
    hlsPlaceholder: 'example.org\nstream.example.net\n按行填写域名，自动去重/清理',
    hlsNote: '这些站点走浏览器提取直链下载（Cloudflare+HLS 流媒体）。保存后立即生效；电脑版同时写入 config.json。',
    hlsSaved: 'HLS 站点已保存（{n} 个域名）',
    hlsEmpty: '暂未配置 HLS 站点',
    language: '语言 / Language',
    // selection modal
    selectTitle: '选择要下载的视频（共 {n} 个）',
    selectAll: '全选', selectNone: '全不选',
    downloadSelected: '下载选中（{n} 个）',
    // drawer
    originalUrl: '原始链接', fileLocation: '文件位置', timestamp: '时间', errorLabel: '错误',
    log: '日志',
    // toasts
    taskAdded: '已添加 {n} 个下载任务',
    taskAddedItems: '已添加 {n} 个下载任务（选中 {m} 集）',
    proxySaved: '代理已保存：{v}', proxyCleared: '已清除代理配置',
    sessdataSaved: 'SESSDATA 已保存，B 站将按登录身份下载', sessdataCleared: '已清除 SESSDATA（回到游客模式）',
    dirReset: '已恢复默认目录 downloads/',
    deleted: '已删除',
    confirmDelete: '删除此历史记录？',
    ok: '删除', cancelBtn: '取消',
    pleaseSelect: '请至少选择一个视频',
    pleasePaste: '请先粘贴链接',
    // footer
    cliHint: 'CLI 方式同样可用：',
    footerNote: '下载文件统一优先 H.264 编码，保证系统播放器可直接播放',
    // stage text
    resolving: '解析中', downloading: '下载中', merging: '合并音视频', queued: '排队中',
    done_: '完成', paused_: '已暂停', cancelled_: '已终止',
    resuming: '恢复中…',
    // detail drawer
    remaining: '剩余',
    // misc
    empty: '空目录',
    thisPC: '此电脑',
    homeDir: '主目录',
    selectThisDir: '选择此目录',
    pleaseEnter: '请先进入一个目录',
    dirSelected: '已选择目录', dirSelectedPath: '已选择: {v}',
    loading: '加载中',
    // 安卓独立模式
    androidPlaceholder: '粘贴视频链接，或整段分享口令（自动识别其中的链接）',
    androidDefaultDir: '下载/VideoDownloader（默认）',
    androidNoTasks: '还没有任务 —— 粘贴链接，点「开始下载」',
    androidProxyNote: '对所有站点生效（YouTube / B站 / HLS）。留空即直连；也可以不填，直接使用手机的系统代理或 VPN。',
    androidFooterNote: '文件保存在系统「下载」目录的 VideoDownloader 文件夹，或你在「保存到」里选的目录',
    addTaskFailed: '添加下载任务失败：{v}',
    dirChosen: '已选择目录：{v}',
  },
  'en': {
    subtitle: 'YouTube · Douyin · Bilibili · Xiaohongshu · More',
    subtitleAndroid: 'YouTube · Bilibili · HLS streaming · Works on its own',
    inputLabel: 'Video URL / Share text (multiple links supported)',
    inputPlaceholder: 'Paste a video URL, or an entire Douyin/Xiaohongshu share text (links auto-detected)\nMultiple links supported, Ctrl+Enter to start',
    quality: 'Quality',
    format: 'Format',
    audioOnly: 'Audio only',
    saveTo: 'Save to',
    browse: 'Browse…',
    reset: 'Reset',
    startDownload: 'Download',
    inspecting: 'Inspecting…',
    tasks: 'Tasks',
    total: '{n} files · {size} total',
    noTasks: 'No tasks yet — paste a link and press Ctrl+Enter to start',
    noTasksPre: 'No tasks yet — paste a link and press ',
    noTasksPost: ' to start',
    noLink: 'No link detected',
    connErr: 'Cannot connect to server, check remote settings',
    stQueued: 'Queued', stRunning: 'Downloading', stDone: 'Done', stError: 'Failed', stPaused: 'Paused', stCancelled: 'Cancelled',
    pause: 'Pause', cancel: 'Cancel', resume: 'Resume', retry: 'Retry',
    openFile: 'Open file', openFolder: 'Open folder', copyPath: 'Copy path', delete: 'Delete',
    copied: 'Copied',
    settings: 'Settings',
    proxyTitle: 'Proxy (HTTP / SOCKS5)',
    proxyPlaceholder: 'http://127.0.0.1:7890 or socks5://127.0.0.1:1080',
    test: 'Test', save: 'Save',
    proxyNote: 'Applies to yt-dlp sites (YouTube, etc.); Douyin/Xiaohongshu use direct connection. Leave empty to disable.',
    sessdataTitle: 'Bilibili Login (SESSDATA, optional)',
    sessdataPlaceholder: 'Paste SESSDATA cookie value to unlock 720p+ quality',
    sessdataNote: 'Get it: Bilibili web → F12 → Application → Cookie → copy SESSDATA value.',
    remoteTitle: 'Remote Mode · Server Address (mobile)',
    remotePlaceholder: 'http://192.168.1.100:8321 (shown by desktop node gui.mjs --lan)',
    remoteNote: 'For Android app / mobile browser (PWA) connecting to desktop. Leave empty for desktop use.',
    hlsTitle: 'HLS streaming sites (Cloudflare-protected, one domain per line)',
    hlsPlaceholder: 'example.org\nstream.example.net\none domain per line, auto-deduped',
    hlsNote: 'These sites download via browser direct-link extraction (Cloudflare+HLS). Takes effect immediately; on desktop also written to config.json.',
    hlsSaved: 'HLS sites saved ({n} domains)',
    hlsEmpty: 'No HLS sites configured',
    language: 'Language / 语言',
    selectTitle: 'Select videos to download ({n} total)',
    selectAll: 'Select all', selectNone: 'Deselect all',
    downloadSelected: 'Download selected ({n})',
    originalUrl: 'Source URL', fileLocation: 'File location', timestamp: 'Time', errorLabel: 'Error',
    log: 'Log',
    taskAdded: '{n} task(s) added',
    taskAddedItems: '{n} task(s) added ({m} selected)',
    proxySaved: 'Proxy saved: {v}', proxyCleared: 'Proxy cleared',
    sessdataSaved: 'SESSDATA saved, Bilibili will use logged-in quality', sessdataCleared: 'SESSDATA cleared (guest mode)',
    dirReset: 'Reset to default directory downloads/',
    deleted: 'Deleted',
    confirmDelete: 'Delete this record?',
    ok: 'Delete', cancelBtn: 'Cancel',
    pleaseSelect: 'Select at least one video',
    pleasePaste: 'Paste a link first',
    cliHint: 'CLI also available:',
    footerNote: 'Downloads prefer H.264 encoding for universal player compatibility',
    resolving: 'Resolving', downloading: 'Downloading', merging: 'Merging A/V', queued: 'Queued',
    done_: 'Done', paused_: 'Paused', cancelled_: 'Cancelled',
    resuming: 'Resuming…',
    remaining: 'remaining',
    empty: '(empty)',
    thisPC: 'This PC',
    homeDir: 'Home',
    selectThisDir: 'Select this folder',
    pleaseEnter: 'Enter a folder first',
    dirSelected: 'Folder selected', dirSelectedPath: 'Selected: {v}',
    loading: 'Loading',
    // Android standalone mode
    androidPlaceholder: 'Paste a video URL or an entire share text (links auto-detected)',
    androidDefaultDir: 'Download/VideoDownloader (default)',
    androidNoTasks: 'No tasks yet — paste a link and tap "Download"',
    androidProxyNote: 'Applies to all sites (YouTube / Bilibili / HLS). Leave empty for a direct connection; you can also skip this and use the system proxy or a VPN.',
    androidFooterNote: 'Files are saved to the VideoDownloader folder in Downloads, or to the folder you picked in "Save to"',
    addTaskFailed: 'Failed to add download task: {v}',
    dirChosen: 'Folder selected: {v}',
  },
};

let currentLang = typeof localStorage !== 'undefined' ? localStorage.getItem('vd.lang') || 'zh-CN' : 'zh-CN';

export function getLang() { return currentLang; }
export function setLang(lang) {
  if (PACKS[lang]) {
    currentLang = lang;
    localStorage.setItem('vd.lang', lang);
  }
}

/** t('key') or t('key', {n: 5, v: 'xxx'}) */
export function t(key, vars) {
  const pack = PACKS[currentLang] || PACKS['zh-CN'];
  let s = pack[key] ?? PACKS['zh-CN'][key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}

export const LANGUAGES = [
  { value: 'zh-CN', label: '中文' },
  { value: 'en', label: 'English' },
];
