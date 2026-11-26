// ffmpeg 校验工具（tests/android-e2e.mjs 与 tests/android-media-check.mjs 共用）。
// 用 ffmpeg 而不是 ffprobe：项目里只随包带了 ffmpeg.exe，而且 ffmpeg 的解码器就是事实上的参考实现。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 优先用项目自带的 ffmpeg（npm run setup 下载的），没有就用 PATH 里的
export const FFMPEG = process.env.FFMPEG || ['ffmpeg.exe', 'ffmpeg'].map((f) => path.join(REPO, 'bin', f)).find((f) => existsSync(f)) || 'ffmpeg';

function ff(args, binary = false) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', ...args], { encoding: binary ? 'buffer' : 'utf8', windowsHide: true, maxBuffer: 512 * 1024 * 1024 });
  if (r.error) throw r.error;
  return r;
}

/** ffmpeg -i 的输出（流信息、时长） */
export const probeText = (file) => ff(['-i', file]).stderr;

/** 整段解码一遍：返回错误输出（空串 = 没有任何解码错误） */
export const decodeErrors = (file) => ff(['-v', 'error', '-i', file, '-f', 'null', '-']).stderr.trim();

/** 时长（秒）；读不到返回 NaN */
export function duration(text) {
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(text);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN;
}

/** 某一路流的时间基（tbn）。ffmpeg 会把 90000 这类值缩写成 "90k" */
function timebase(text, stream) {
  const line = text.split('\n').find((l) => l.includes(`Stream #0:${stream}`));
  assert.ok(line, `找不到流 #0:${stream}:\n${text}`);
  const m = /([\d.]+)\s*(k?) tbn/.exec(line);
  assert.ok(m, `这一行没有时间基: ${line}`);
  return Number(m[1]) * (m[2] ? 1000 : 1);
}

/** 逐帧解码：[{pts 秒, md5}, …]，按显示顺序 */
export function frameRows(file) {
  const text = ff(['-v', 'error', '-i', file, '-map', '0:v:0', '-an', '-f', 'framemd5', '-']).stdout;
  const tbn = timebase(probeText(file), 0);
  return text.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => {
    const c = l.trim().split(/,\s*/);
    return { pts: Number(c[2]) / tbn, md5: c[5] };
  });
}

/** 解码后的 PCM 哈希 */
export const audioMd5 = (file) => ff(['-v', 'error', '-i', file, '-map', '0:a:0', '-vn', '-f', 'md5', '-']).stdout.trim();

/** 解码成原始 PCM（16 位有符号、交错）：{ channels, rate, samples, data } */
export function audioPcm(file) {
  const r = ff(['-v', 'error', '-i', file, '-map', '0:a:0', '-vn', '-f', 's16le', '-']);
  const info = /\b(\d+) Hz, (?:\w+, )?(\d+) ch/.exec(probeText(file).replace(/\n/g, ' ')) || [];
  const channels = Number(info[2] || 2);
  const data = r.stdout ? Buffer.from(r.stdout, 'binary') : Buffer.alloc(0);
  return { rate: Number(info[1] || 0), channels, data, samples: data.length / (2 * channels) };
}

/**
 * 断言两个文件的音频在解码后一致：每一帧的采样内容必须逐字节相同。
 * 总采样数允许相差不超过 [tolerance] 个（默认 16，远小于一帧的 1024）：
 * ffmpeg 会按文件声明的时长裁掉结尾的零头，不同工具生成的文件在这里可能差几个采样，这不是内容差异。
 */
export function assertSameAudio(a, b, label, tolerance = 16) {
  const pa = audioPcm(a);
  const pb = audioPcm(b);
  assert.equal(pa.channels, pb.channels, `${label}: 声道数不同`);
  assert.equal(pa.rate, pb.rate, `${label}: 采样率不同`);
  assert.ok(Math.abs(pa.samples - pb.samples) <= tolerance, `${label}: 音频长度相差太多（${pa.samples} vs ${pb.samples} 个采样）`);
  // 只比较到两边都有、且是整帧的位置；最后那一帧不比（零头差异就在那里）
  const frame = 1024 * 2 * pa.channels;
  const comparable = Math.floor(Math.min(pa.data.length, pb.data.length) / frame - 1) * frame;
  let at = -1;
  for (let i = 0; i < comparable; i += 4096) {
    if (!pa.data.subarray(i, Math.min(i + 4096, comparable)).equals(pb.data.subarray(i, Math.min(i + 4096, comparable)))) {
      at = i;
      break;
    }
  }
  assert.equal(at, -1, `${label}: 音频内容不同（第一处差异在字节偏移 ${at}，约第 ${Math.floor(at / frame)} 帧）`);
  return { samples: pa.samples, delta: pa.samples - pb.samples };
}

/**
 * 断言两个文件的画面逐帧相同：每一帧的解码哈希、每一帧相对首帧的显示时刻都必须一致。
 * 这比「能播」「有视频流」严格得多——封装时把 B 帧顺序弄错、时间戳错位，都会在这里现形。
 * 显示时刻按「相对首帧」比较：不同工具对「第一帧放在 0 还是稍后」的处理不同（比如 ffmpeg 处理 TS 时
 * 会让视频比音频晚 23ms 起播），帧与帧之间的相对节奏才是封装是否正确的判据。
 * @returns 帧数
 */
export function assertSameVideo(a, b, label, maxReport = 3) {
  const fa = frameRows(a);
  const fb = frameRows(b);
  assert.equal(fa.length, fb.length, `${label}: 帧数不同（${fa.length} vs ${fb.length}）`);
  const diffs = [];
  const originA = fa[0]?.pts ?? 0;
  const originB = fb[0]?.pts ?? 0;
  for (let i = 0; i < fa.length; i++) {
    const ta = fa[i].pts - originA;
    const tb = fb[i].pts - originB;
    if (fa[i].md5 !== fb[i].md5) diffs.push(`第 ${i} 帧画面不同: ${path.basename(a)} ${fa[i].md5} vs ${path.basename(b)} ${fb[i].md5}`);
    else if (Math.abs(ta - tb) >= 0.001) diffs.push(`第 ${i} 帧显示时刻不同（相对首帧）: ${ta.toFixed(5)} vs ${tb.toFixed(5)}`);
  }
  assert.equal(diffs.length, 0, `${label}: ${diffs.length}/${fa.length} 帧不一致\n  ` + diffs.slice(0, maxReport).join('\n  '));
  assertSameKeyframes(a, b, label);
  return fa.length;
}

/**
 * 第一个视频轨的关键帧表（stss），返回关键帧的帧序号（从 0 起）。没有 stss 表示全是关键帧。
 * 直接读文件里的 box，不经过 ffmpeg：这一项比的就是「我们写进文件的关键帧标记」和「ffmpeg 写的」是否一样。
 * 分片文件（带 moof）的关键帧标记在各分片里，这里不解析，返回 null。
 */
export function keyframeTable(file) {
  const b = readFileSync(file);
  const u32 = (p) => b.readUInt32BE(p);
  const u64 = (p) => Number(b.readBigUInt64BE(p));
  const children = (start, end) => {
    const out = [];
    for (let p = start; p + 8 <= end; ) {
      let size = u32(p);
      let head = 8;
      if (size === 1) { size = u64(p + 8); head = 16; } else if (size === 0) size = end - p;
      if (size < 8) break;
      out.push({ type: b.toString('latin1', p + 4, p + 8), payload: p + head, end: p + size });
      p += size;
    }
    return out;
  };
  const child = (boxes, type) => boxes.find((x) => x.type === type);
  const top = children(0, b.length);
  const moov = child(top, 'moov');
  assert.ok(moov, `${path.basename(file)}: 没有 moov`);
  if (top.some((x) => x.type === 'moof')) return null;
  for (const trak of children(moov.payload, moov.end).filter((x) => x.type === 'trak')) {
    const mdia = child(children(trak.payload, trak.end), 'mdia');
    const hdlr = mdia && child(children(mdia.payload, mdia.end), 'hdlr');
    if (!hdlr || b.toString('latin1', hdlr.payload + 8, hdlr.payload + 12) !== 'vide') continue;
    const minf = child(children(mdia.payload, mdia.end), 'minf');
    const stbl = child(children(minf.payload, minf.end), 'stbl');
    const boxes = children(stbl.payload, stbl.end);
    const stsz = child(boxes, 'stsz');
    const count = u32(stsz.payload + 8);
    const stss = child(boxes, 'stss');
    if (!stss) return Array.from({ length: count }, (_, i) => i);
    const n = u32(stss.payload + 4);
    return Array.from({ length: Math.min(n, count) }, (_, i) => u32(stss.payload + 8 + i * 4) - 1);
  }
  return [];
}

/**
 * 断言两个文件的关键帧表一致。逐帧比对看不出这一项 —— 把所有帧都标成关键帧，画面照样逐帧相同、照样能从头播，
 * 但播放器拖动进度条时会从非关键帧开始解码，花屏到下一个关键帧为止。
 */
export function assertSameKeyframes(a, b, label) {
  const ka = keyframeTable(a);
  const kb = keyframeTable(b);
  if (!ka || !kb) return; // 分片文件的关键帧不在 stss 里；或者文件里没有视频轨
  const firstDiff = ka.findIndex((x, i) => x !== kb[i]);
  assert.ok(
    ka.length === kb.length && firstDiff < 0,
    `${label}: 关键帧表不一致 —— ${path.basename(a)} 有 ${ka.length} 个关键帧，参考有 ${kb.length} 个` +
      (firstDiff >= 0 ? `；从第 ${firstDiff} 项起不同（${ka[firstDiff]} vs ${kb[firstDiff]}）` : '') +
      `\n  参考: ${kb.slice(0, 12).join(', ')}${kb.length > 12 ? ', …' : ''}`,
  );
}

/**
 * 一路流第一个包的显示时间（秒）：直接读解封装出来的包时间戳。
 * 不用 `ffmpeg -i` 打印的 start 字段 —— 它对视频按解码时间算，而带 B 帧的视频「第一帧何时显示」看的是显示时间。
 * @param kind 'v' 或 'a'
 */
export function firstPts(file, kind) {
  // showinfo 打印的是「输出帧」的时间：输出按显示顺序排列，第 0 帧就是第一帧显示的画面
  const args = kind === 'v'
    ? ['-v', 'info', '-i', file, '-map', '0:v:0', '-an', '-vf', 'showinfo', '-frames:v', '1', '-f', 'null', '-']
    : ['-v', 'info', '-i', file, '-map', '0:a:0', '-vn', '-af', 'ashowinfo', '-t', '0.2', '-f', 'null', '-'];
  const m = /\bn:\s*0\s+pts:\s*-?\d+\s+pts_time:(-?[\d.]+)/.exec(ff(args).stderr);
  return m ? Number(m[1]) : NaN;
}

/**
 * 断言两个文件的音画起点关系一致：「视频第一帧的显示时间 − 音频第一个包的显示时间」在两个文件里必须相同。
 * 逐帧比对只管画面自身的节奏；音轨整体提前或滞后，只有这一项能查出来。
 */
export function assertAVSync(a, b, label, tolerance = 0.002) {
  const da = firstPts(a, 'v') - firstPts(a, 'a');
  const db = firstPts(b, 'v') - firstPts(b, 'a');
  const ms = (x) => `${(Math.abs(x) * 1000).toFixed(1)}ms`;
  assert.ok(Number.isFinite(da) && Number.isFinite(db), `${label}: 读不到音视频起点（${da} / ${db}）`);
  assert.ok(Math.abs(da - db) <= tolerance, `${label}: 音画起点关系不一致：视频比音频${da >= 0 ? '晚' : '早'} ${ms(da)}，参考是${db >= 0 ? '晚' : '早'} ${ms(db)}`);
  return { mine: da, ref: db };
}

/** 断言一个文件是「能完整播放」的：有声有画、整段解码零错误。返回流信息行 */
export function assertPlayable(file, { video = 'h264', audio = 'aac', label = path.basename(file) } = {}) {
  const errs = decodeErrors(file);
  assert.equal(errs, '', `${label}: 整段解码不应有错误:\n${errs}`);
  const info = probeText(file);
  assert.match(info, new RegExp(`Video: ${video}`), `${label}: 应有 ${video} 视频:\n${info}`);
  assert.match(info, new RegExp(`Audio: ${audio}`), `${label}: 应有 ${audio} 音频:\n${info}`);
  return {
    info,
    duration: duration(info),
    streams: info.split('\n').filter((l) => l.includes('Stream #')).map((l) => l.trim()),
    resolution: /Video: [^,]+[^]*?(\d{3,5}x\d{3,5})/.exec(info)?.[1] ?? null,
  };
}
