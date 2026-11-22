// 站点配置：每个站点有自己的默认格式策略，未匹配的 URL 走 yt-dlp 默认行为

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

const BILIBILI_HOSTS = new Set([
  'bilibili.com',
  'www.bilibili.com',
  'm.bilibili.com',
  'b23.tv', // 分享短链
  'www.b23.tv',
]);

const sites = [
  {
    id: 'youtube',
    match: (url) => YOUTUBE_HOSTS.has(url.hostname) || url.hostname.endsWith('.youtube.com'),
    // 必须显式锁定 avc1(H.264)+aac：yt-dlp 默认排序同分辨率时偏好 VP9，
    // 而 VP9-in-mp4 在 Windows 自带播放器里只有声音没有画面
    format: 'bv*[vcodec^=avc1]+ba[acodec^=mp4a]/bv*[vcodec^=avc1]+ba/bv*+ba/b',
    mergeFormat: 'mp4',
  },
  {
    id: 'bilibili',
    match: (url) => BILIBILI_HOSTS.has(url.hostname),
    // B 站有 av01/hev1(h265)/avc1 三系流，默认排序会选 av01 → Windows 播放器兼容性差，
    // 同 YouTube 锁定 avc1+m4a
    format: 'bv*[vcodec^=avc1]+ba[acodec^=mp4a]/bv*[vcodec^=avc1]+ba/bv*+ba/b',
    mergeFormat: 'mp4',
  },
  {
    id: 'douyin',
    // 抖音有 Argus 风控签名，yt-dlp 搞不定，走自研引擎（src/douyin.mjs）
    engine: 'douyin',
    match: (url) =>
      url.hostname === 'v.douyin.com' ||
      ['douyin.com', 'www.douyin.com', 'www.iesdouyin.com'].includes(url.hostname),
  },
  {
    id: 'xiaohongshu',
    // yt-dlp 不支持小红书；网关级反爬 → 无头 Edge 读页面 SSR 数据（src/xiaohongshu.mjs）
    // 注意：需要 App 分享出来的链接（xhslink.com 短链或带 xsec_token 的长链），裸链接会被拦
    engine: 'xiaohongshu',
    match: (url) =>
      ['xiaohongshu.com', 'www.xiaohongshu.com', 'xhslink.com', 'www.xhslink.com'].includes(url.hostname),
  },
];

export function matchSite(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  return sites.find((s) => s.match(url)) ?? null;
}

/** 从任意文本（如抖音分享口令）中抽取 URL */
export function extractUrls(text) {
  const found = text.match(/https?:\/\/[^\s'"，。,；;<>（）()【】\[\]]+/g) || [];
  return found.map((u) => u.replace(/[).,!?！？;；:：]+$/, ''));
}
