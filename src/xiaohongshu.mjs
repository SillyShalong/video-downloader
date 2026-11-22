// 小红书自定义引擎（yt-dlp 不支持）：
//   分享链接（xhslink.com 短链 / 带 xsec_token 的长链，游客可看；裸链接会被 300031 拦截）
//   → 无头 Edge 打开笔记页 → 直接读 window.__INITIAL_STATE__（页面 SSR 数据，无需调 API）
//   → h264 流 masterUrl + backupUrls 作为多镜像直链下载
// 反爬在网关级（自造请求 406），只能驱动真实浏览器，与抖音引擎同理。
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { withPage, evalInPage } from './headless-edge.mjs';
import { downloadFile } from './download-file.mjs';

/** xhslink.com 短链 302 到带 xsec_token 的笔记页；保留完整 URL（token 必须带上） */
async function resolveNote(url) {
  const res = await fetch(url, { redirect: 'follow' });
  res.body?.cancel().catch(() => {});
  const final = res.url;
  const id = final.match(/(?:explore|discovery\/item|notes)\/([0-9a-f]{16,})/)?.[1];
  if (!id) throw new Error(`无法从链接解析笔记 ID（最终地址: ${final.slice(0, 120)}）`);
  return { id, pageUrl: final.split('&xsec_source=')[0] };
}

/** 页面上下文提取笔记数据（结构随版本可能变化，多级字段兜底） */
function extractNote(cdp, sessionId, id) {
  const expr = `(() => {
    try {
      const s = window.__INITIAL_STATE__;
      if (!s) return { fatal: '页面无 __INITIAL_STATE__（可能被风控拦截），title=' + document.title };
      const map = s.note && s.note.noteDetailMap;
      const entry = (map && (map[${JSON.stringify(id)}] || Object.values(map)[0])) || null;
      const note = (entry && (entry.note || entry)) || null;
      if (!note) return { fatal: '笔记数据未加载（可能需要登录或链接失效），state.note keys=' + Object.keys(s.note || {}).join(',') };
      const v = note.video || {};
      const media = v.media || (v.video && v.video.media) || null;
      const stream = media && media.stream;
      // h264 优先（播放兼容），其次 h265；字段兼容驼峰/下划线两种命名
      const pick = (arr) => (Array.isArray(arr) && arr.length > 0 ? arr : null);
      const h264 = pick(stream && (stream.h264 || stream.h_264));
      const h265 = pick(stream && (stream.h265 || stream.h_265));
      const gear = h264 || h265;
      const urls = [];
      if (gear) {
        for (const g of gear) {
          const master = g.masterUrl || g.master_url;
          if (master) urls.push(master);
          const backups = g.backupUrls || g.backup_urls;
          if (Array.isArray(backups)) urls.push(...backups.filter(Boolean));
        }
      }
      return {
        type: note.type,
        title: note.title || '',
        desc: (note.desc || '').slice(0, 60),
        nickname: (note.user && note.user.nickname) || '',
        codec: h264 ? 'h264' : h265 ? 'h265' : null,
        urls,
        noteKeys: Object.keys(note).slice(0, 30),
        videoKeys: Object.keys(v).slice(0, 20),
      };
    } catch (e) { return { fatal: String(e) }; }
  })()`;
  return evalInPage(cdp, sessionId, expr);
}

function sanitizeName(s) {
  return (
    String(s || '')
      .replace(/[\\/:*?"<>|\r\n\t#]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .slice(0, 100) || 'xiaohongshu_video'
  );
}

/** 下载小红书视频。事件协议与 douyin 引擎一致。 */
export async function downloadXiaohongshu(url, opts = {}) {
  const { outDir, quality, onEvent } = opts;
  mkdirSync(outDir, { recursive: true });

  const { id, pageUrl } = await resolveNote(url);

  const info = await withPage(
    pageUrl,
    async ({ cdp, sessionId }) => extractNote(cdp, sessionId, id),
    { settleMs: 5000 },
  );

  if (info.fatal) throw new Error(`小红书: ${info.fatal}`);
  if (info.type !== 'video') throw new Error('这是图文笔记，暂只支持视频笔记');
  if (!info.urls || info.urls.length === 0) {
    // 带上实际字段名便于排查结构变化
    throw new Error(`未找到视频流（noteKeys=${(info.noteKeys || []).join(',')} videoKeys=${(info.videoKeys || []).join(',')}）`);
  }

  const title = sanitizeName(info.title || info.desc || `${info.nickname || '小红书'}的视频`);
  onEvent?.({ type: 'title', title: `${info.nickname ? '@' + info.nickname + ' ' : ''}${title}` });
  const dest = path.join(outDir, `${title} [${id}].mp4`);
  if (existsSync(dest)) {
    onEvent?.({ type: 'file', file: dest });
    return { url, files: [dest] };
  }

  onEvent?.({ type: 'info', raw: `[xhs] @${info.nickname || '未知'} 《${title}》 开始下载（${info.codec}）` });
  await downloadFile(info.urls, dest, {
    onProgress: (p) => onEvent?.({ type: 'progress', percent: p.percent, raw: p.raw }),
    headers: { referer: 'https://www.xiaohongshu.com/' },
  });
  onEvent?.({ type: 'file', file: dest });
  return { url, files: [dest] };
}
