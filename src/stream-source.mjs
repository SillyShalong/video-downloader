// 视频流来源：把「真正在下的是哪个地址」整理成界面能直接显示的形式。
//
// 页面链接和视频流地址是两回事：后者通常在 CDN 的另一个域名上（YouTube 是 *.googlevideo.com，
// B 站是 *.bilivideo.com 等）。遇到 403、卡顿、想确认走的是哪条线路时，要看的是后者。
//
// 三条下载路径各自怎么拿到地址：
//   - yt-dlp（YouTube / B站 / 其它站点）：让它在下载前把选中的格式打印出来（SOURCE_PRINT_ARGS）
//   - HLS 站点：同上（m3u8 也是交给 yt-dlp 下）
//   - 抖音 / 小红书：引擎自己拿到的直链（streamsFromUrls）
//
// IP 的含义要说清楚：它是「本机此刻把这个域名解析成什么」，和 yt-dlp 用的是同一个系统解析器，
// 但不是抓包得到的连接对端 —— CDN 会轮换地址，两者可能不同。走了代理时连的其实是代理，
// 视频流的域名由代理那一侧解析，这时只给代理的地址。
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * 传给 yt-dlp 的 --print 参数：下载前把选中的格式打出来，每行带固定标记。
 * 一个视频一组、顺序固定，最后一行（__SRC_INFO__）到了就算收齐。播放列表里的每个视频各一组。
 */
const SOURCE_MARKERS = ['__SRC_FORMATS__', '__SRC_URL__', '__SRC_URLS__', '__SRC_MANIFEST__', '__SRC_INFO__'];
export const SOURCE_PRINT_ARGS = [
  '__SRC_FORMATS__%(requested_formats)j', // 合成格式（视频 + 音频各一路）：每一路的完整信息，JSON
  '__SRC_URL__%(url)s', // 单一格式：直链；分段流（HLS/DASH）没有
  '__SRC_URLS__%(urls)j', // 分段地址
  '__SRC_MANIFEST__%(manifest_url)s', // 分段流：m3u8 / mpd 播放列表地址
  '__SRC_INFO__%(format_id)s|%(format)s|%(vcodec)s|%(acodec)s|%(protocol)s|%(ext)s',
].map((tmpl) => ['--print', `before_dl:${tmpl}`]).flat();

const LOOKUP_TIMEOUT_MS = 4000;
const MAX_IPS = 6;
/** 同一个域名多久之内不重复解析（解析失败只记一小会儿：多半是瞬时问题，下次就该重试） */
const CACHE_MS = 5 * 60_000;
const FAIL_CACHE_MS = 30_000;
const ipCache = new Map(); // hostname → { at, ips }

/**
 * 收集 yt-dlp 的来源行。
 * @returns undefined：不是来源行；null：是，但这一组还没收齐；数组：这一组收齐了，解析出的流
 */
export function createSourceCollector() {
  const parts = {};
  return (line) => {
    const text = String(line).trim();
    const marker = SOURCE_MARKERS.find((m) => text.startsWith(m));
    if (!marker) return undefined;
    parts[marker] = text.slice(marker.length);
    if (marker !== SOURCE_MARKERS[SOURCE_MARKERS.length - 1]) return null;
    const got = { ...parts };
    for (const m of SOURCE_MARKERS) delete parts[m];
    try {
      return streamsFromYtDlp(got);
    } catch {
      return null; // yt-dlp 的输出不合预期：来源显示不出来，但不影响下载
    }
  };
}

/** 把一组来源行解析成流。入参的键就是标记名（见 SOURCE_MARKERS） */
export function streamsFromYtDlp(parts) {
  const formats = parseJson(parts.__SRC_FORMATS__);
  if (Array.isArray(formats) && formats.length > 0) return formats.map((f) => streamFromFormat(f ?? {}));
  // 单一格式：信息在 __SRC_INFO__ 这一行里。format 一栏自己也可能带竖线，所以头尾各取固定的个数
  const info = String(parts.__SRC_INFO__ ?? '').split('|');
  const [formatId, vcodec, acodec, protocol, ext] = [info[0], info.at(-4), info.at(-3), info.at(-2), info.at(-1)];
  return [
    streamFromFormat({
      format_id: text(formatId),
      format: info.slice(1, -4).join('|'),
      vcodec,
      acodec,
      protocol: text(protocol),
      ext: text(ext),
      url: text(parts.__SRC_URL__),
      urls: parseJson(parts.__SRC_URLS__),
      manifest_url: text(parts.__SRC_MANIFEST__),
    }),
  ];
}

/** 引擎自己拿到的直链（抖音 / 小红书）：第一个是主地址，其余是备用地址 */
export function streamsFromUrls(urls) {
  const links = (Array.isArray(urls) ? urls : [urls]).filter((u) => typeof u === 'string' && u).map((url) => withHost({ url }));
  if (links.length === 0) return [];
  return [{ role: 'both', label: '', protocol: links[0].url.split(':')[0], links: links.map((l, i) => ({ ...l, kind: i === 0 ? 'url' : 'alternate' })) }];
}

/**
 * 给每条地址补上「本机解析出的 IP」。不抛错：解析不出来就是空数组（界面显示「未解析到」）。
 * @returns {Promise<{streams: Array, proxy: {display: string, host: string, ips: string[]} | null}>}
 */
export async function annotateIps(streams, { proxy } = {}) {
  const out = streams.map((s) => ({ ...s, links: s.links.map((l) => ({ ...l, ips: [] })) }));
  if (proxy) {
    const u = parseUrl(proxy);
    const px = { display: u ? `${u.protocol}//${u.host}` : String(proxy), hostname: u?.hostname ?? null, ips: [] };
    px.ips = (await resolveIps(px.hostname)) ?? [];
    return { streams: out, proxy: px };
  }
  const hosts = new Set(out.flatMap((s) => s.links.map((l) => l.hostname)).filter(Boolean));
  const resolved = new Map(await Promise.all([...hosts].map(async (h) => [h, (await resolveIps(h)) ?? []])));
  for (const s of out) for (const l of s.links) l.ips = resolved.get(l.hostname) ?? [];
  return { streams: out, proxy: null };
}

/**
 * 发出「视频流来源」事件：先立刻发一次（IP 还在解析），解析完再发一次。不等解析，下载照常开始。
 * @param {number|string} id 同一组来源的两次事件用同一个 id，接收方据此更新而不是追加
 */
export function emitSource(onEvent, streams, { proxy, id } = {}) {
  // 一个地址都没有的流（比如 yt-dlp 这次什么都没打出来）不显示
  const usable = streams?.filter((s) => s.links.length > 0) ?? [];
  if (!onEvent || usable.length === 0) return;
  const sourceId = id ?? Symbol();
  onEvent({ type: 'source', sourceId, streams: usable, proxy: proxy ? { display: redact(proxy), hostname: parseUrl(proxy)?.hostname ?? null, ips: [] } : null });
  annotateIps(usable, { proxy })
    .then((r) => onEvent({ type: 'source', sourceId, ...r }))
    .catch(() => {});
}

/** 日志里的一行：列出域名和解析到的 IP（去了重） */
export function summarizeSources({ streams, proxy }) {
  const items = [];
  if (proxy) items.push(`${proxy.display}${fmtIps(proxy.ips)}`);
  const seen = new Set();
  for (const s of streams) {
    for (const l of s.links) {
      if (!l.host || seen.has(l.host)) continue;
      seen.add(l.host);
      items.push(`${l.host}${proxy ? '' : fmtIps(l.ips)}`);
    }
  }
  return items.join(' · ') || '（未取到视频流地址）';
}

/* ---------------- 内部 ---------------- */

function streamFromFormat(f) {
  const video = f.vcodec && f.vcodec !== 'none';
  const audio = f.acodec && f.acodec !== 'none';
  const role = audio && !video ? 'audio' : video && !audio ? 'video' : 'both';
  // 137 · 1080p · mp4（纯音频没有分辨率；直链文件的 format_id 常常就是扩展名，不重复写）
  const note = f.height ? `${f.height}p` : f.format_note && f.format_note !== 'audio only' ? f.format_note : '';
  const label = [...new Set([f.format_id, note, f.ext].filter(Boolean))].join(' · ');
  const links = [];
  const manifest = text(f.manifest_url);
  if (text(f.url)) links.push({ kind: 'url', url: f.url });
  if (manifest) links.push({ kind: 'manifest', url: manifest });
  // 分段地址只用来知道分段在哪个域名上：同一个域名记一次就够了
  const hosts = new Set(links.map((l) => hostOf(l.url)));
  for (const u of urlList(f.urls)) {
    const h = hostOf(u);
    if (!h || hosts.has(h)) continue;
    hosts.add(h);
    links.push({ kind: 'segment', url: u });
  }
  return { role, label: label || text(f.format) || '', protocol: f.protocol || '', links: links.map(withHost) };
}

function withHost(l) {
  const u = parseUrl(l.url);
  // IPv6 字面量的主机名带方括号（[::1]），去掉才能按 IP 认
  return { ...l, host: u?.host ?? null, hostname: u?.hostname.replace(/^\[|\]$/g, '') ?? null, ips: null };
}

function urlList(v) {
  if (Array.isArray(v)) return v.filter((u) => typeof u === 'string' && u);
  if (typeof v === 'string') return v.split('\n').filter(Boolean);
  return [];
}

function parseJson(v) {
  if (v == null || v === 'NA') return null;
  return JSON.parse(v);
}

function text(v) {
  return v == null || v === 'NA' ? null : String(v);
}

function parseUrl(u) {
  try {
    return new URL(String(u));
  } catch {
    return null;
  }
}

function hostOf(u) {
  return parseUrl(u)?.host ?? null;
}

/** 代理地址只留协议和主机端口，账号密码不外传 */
function redact(proxy) {
  const u = parseUrl(proxy);
  return u ? `${u.protocol}//${u.host}` : String(proxy);
}

function fmtIps(ips) {
  if (ips == null) return '（解析中…）';
  if (ips.length === 0) return '（未解析到 IP）';
  return ` → ${ips.slice(0, 2).join(', ')}${ips.length > 2 ? ` 等 ${ips.length} 个` : ''}`;
}

/**
 * 域名此刻在本机解析到的地址；超时或解析失败返回 null。
 * IPv4 / IPv6 字面量原样返回。
 */
export async function resolveIps(hostname) {
  if (!hostname) return null;
  if (isIP(hostname)) return [hostname];
  const hit = ipCache.get(hostname);
  if (hit && Date.now() - hit.at < (hit.ips ? CACHE_MS : FAIL_CACHE_MS)) return hit.ips;
  let timer;
  let ips = null;
  try {
    const rows = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('dns timeout')), LOOKUP_TIMEOUT_MS);
      }),
    ]);
    ips = [...new Set(rows.map((r) => r.address))].slice(0, MAX_IPS);
  } catch {
    ips = null;
  } finally {
    clearTimeout(timer);
  }
  ipCache.set(hostname, { at: Date.now(), ips });
  return ips;
}
