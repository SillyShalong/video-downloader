// 抖音自定义引擎：
//   短链 → 无头 Edge 打开视频页 → 页面上下文 fetch detail API（SDK 自动签名，绕过 Argus 风控）
//   → 从 bit_rate 挑选画质档位 → douyinvod CDN 直链下载（web play_addr，无水印）
// yt-dlp 的 DouyinIE 无法生成签名 cookie，因此不走 yt-dlp。
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { withPage, evalInPage } from './headless-edge.mjs';
import { downloadFile } from './download-file.mjs';
import { emitSource, streamsFromUrls } from './stream-source.mjs';

/** v.douyin.com 短链 302 到 www.douyin.com/video/<id>，取最终地址里的作品 ID */
async function resolveItem(url) {
  const res = await fetch(url, { redirect: 'follow' });
  res.body?.cancel().catch(() => {});
  const final = res.url;
  const m = final.match(/\/(video|note)\/(\d+)/);
  if (!m) throw new Error(`无法从链接解析作品 ID（最终地址: ${final}）`);
  return { id: m[2], pageUrl: final, isNote: m[1] === 'note' };
}

function extractDetail(cdp, sessionId, id) {
  // 抖音的 webmssdk hook 了页面内的 fetch/XHR，自动附加 a_bogus 签名
  const expr = `(async () => {
    try {
      const r = await fetch('/aweme/v1/web/aweme/detail/?aweme_id=${id}&device_platform=webapp&aid=6383', {
        headers: { accept: 'application/json, text/plain, */*' },
        credentials: 'include',
      });
      return JSON.stringify({ status: r.status, body: await r.text() });
    } catch (e) {
      return JSON.stringify({ status: 0, err: String(e) });
    }
  })()`;
  return evalInPage(cdp, sessionId, expr).then((s) => JSON.parse(s));
}

/** 从 bit_rate 里挑 h264 画质档（height 限制时选不超过该值的最高档） */
function pickUrls(video, maxHeight) {
  const gears = (video.bit_rate || [])
    .filter((b) => !b.is_h265 && (b.play_addr?.url_list || []).length > 0)
    .map((b) => {
      const h = Number((b.gear_name?.match(/(\d{3,4})_/) || [])[1] || 0);
      return { h, br: b.bit_rate, urls: b.play_addr.url_list };
    })
    .sort((a, b) => b.h - a.h || b.br - a.br);
  let pool = maxHeight ? gears.filter((g) => g.h <= maxHeight) : gears;
  if (pool.length === 0) pool = gears;
  if (pool.length === 0) {
    const urls = video.play_addr?.url_list || [];
    if (urls.length === 0) throw new Error('未找到可用的播放地址');
    return urls;
  }
  return pool[0].urls;
}

function sanitizeName(s) {
  return (
    s
      .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .slice(0, 100) || 'douyin_video'
  );
}

/**
 * 下载抖音视频。事件协议与 downloader.mjs 的 yt-dlp 路径一致：
 * onEvent({type:'progress'|'file', ...})，返回 { url, files }
 */
export async function downloadDouyin(url, opts = {}) {
  const { outDir, quality, onEvent, signal } = opts;
  mkdirSync(outDir, { recursive: true });

  const { id, pageUrl, isNote } = await resolveItem(url);

  const info = await withPage(
    pageUrl,
    async ({ cdp, sessionId }) => extractDetail(cdp, sessionId, id),
    { settleMs: 5000 },
  );

  if (info.status !== 200) throw new Error(`抖音 detail API 返回 ${info.status}${info.err ? ` (${info.err})` : ''}`);
  const detail = JSON.parse(info.body)?.aweme_detail;
  if (!detail) throw new Error('抖音 detail API 未返回视频数据（风控拦截，可稍后重试）');
  if (isNote || (detail.images?.length ?? 0) > 0) {
    throw new Error('这是图文作品，暂只支持视频');
  }

  const title = sanitizeName(detail.desc || `${detail.author?.nickname || 'douyin'}的视频`);
  onEvent?.({ type: 'title', title: `${detail.author?.nickname ? '@' + detail.author.nickname + ' ' : ''}${title}` });
  const dest = path.join(outDir, `${title} [${id}].mp4`);
  if (existsSync(dest)) {
    onEvent?.({ type: 'file', file: dest });
    return { url, files: [dest] };
  }

  const urls = pickUrls(detail.video, quality);
  onEvent?.({ type: 'info', raw: `[douyin] @${detail.author?.nickname || '未知'} 《${title}》 开始下载` });
  emitSource(onEvent, streamsFromUrls(urls)); // 视频流直链的域名 / IP，详情里显示
  await downloadFile(urls, dest, {
    onProgress: (p) =>
      onEvent?.({ type: 'progress', percent: p.percent, speed: p.speed, eta: p.eta, total: p.total, downloaded: p.done }),
    headers: { referer: 'https://www.douyin.com/' },
    signal,
  });
  onEvent?.({ type: 'file', file: dest });
  return { url, files: [dest] };
}
