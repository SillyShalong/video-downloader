#!/usr/bin/env node
// MP4 重封装器（android/app/src/main/java/.../mp4）的正确性校验 —— 在电脑上跑，不需要设备。
//
//   node tests/android-media-check.mjs          合成媒体（ffmpeg 生成：带 B 帧的视频 + 带编码预滚的音频）
//   node tests/android-media-check.mjs --yt     另外用 yt-dlp 取真实的 YouTube 视频流 / 音频流
//
// 三步：
//   1. 准备媒体文件（fixtures）
//   2. 跑 JVM 单测 Mp4MuxerTest，把 fixtures 目录传进去，由我们自己的 Mp4Reader / Mp4Writer 重封装
//   3. 用 ffmpeg 逐帧、逐采样比对：重封装结果必须与 `ffmpeg -c copy` 的参考结果完全一致
//      （画面逐帧哈希相同、显示时刻相同、音频解码结果相同、整段解码零错误、音画起点关系相同）
// 这是 YouTube / HLS 下载后「音视频合成」这一步的守门测试：合成错一帧都会在这里被拦下。
//
// 需要 JDK 21 和 Android SDK（同安卓工程本身）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGradle } from '../scripts/android-gradle.mjs';
import { FFMPEG, assertAVSync, assertPlayable, assertSameAudio, assertSameVideo, duration, probeText } from './media-tools.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 优先用项目自带的 yt-dlp（npm run setup 下载的），没有就用 PATH 里的
const YTDLP = process.env.YTDLP || ['yt-dlp.exe', 'yt-dlp'].map((f) => path.join(REPO, 'bin', f)).find((f) => existsSync(f)) || 'yt-dlp';
const DIR = (process.env.VD_FIXTURES || path.join(tmpdir(), 'vd-media-fixtures')).split(path.sep).join('/');
const OUT = path.join(DIR, 'out');
const YT_URL = process.env.VD_MEDIA_YT_URL || 'https://www.youtube.com/watch?v=A5sE7l8SbL4';
const withYt = process.argv.includes('--yt');

function run(cmd, args, { allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) throw new Error(`${path.basename(cmd)} ${args.join(' ')}\n退出码 ${r.status}\n${r.stderr}`);
  return r;
}
const ff = (args) => run(FFMPEG, ['-hide_banner', '-nostdin', '-y', ...args]);

/* ------------------------------------------------------------ 1. fixtures */
function generate() {
  mkdirSync(DIR, { recursive: true });
  rmSync(OUT, { recursive: true, force: true });
  const v = path.join(DIR, 'synth.video.mp4');
  const a = path.join(DIR, 'synth.audio.m4a');
  const s = path.join(DIR, 'synth.single.mp4');
  if (!existsSync(v)) {
    // 3 个连续 B 帧、30 帧一个 GOP：解码顺序与显示顺序明显不同
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '8', '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high',
      '-bf', '3', '-g', '30', '-pix_fmt', 'yuv420p', v]);
  }
  if (!existsSync(a)) ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=8', '-ac', '2', '-c:a', 'aac', '-b:a', '128k', a]);
  if (!existsSync(s)) ff(['-i', v, '-i', a, '-c', 'copy', s]);
  // 分片 MP4（音视频两条轨在同一个文件的多个分片里）：YouTube 的视频流、HLS 的 fMP4 都是这种格式
  const frag = path.join(DIR, 'frag.single.mp4');
  if (!existsSync(frag)) ff(['-i', s, '-c', 'copy', '-movflags', '+frag_keyframe+empty_moof+default_base_moof', frag]);
  // HLS 的 fMP4：初始化段 + 若干分段文件首尾相接（每个分段自带 styp / sidx / moof / mdat）。
  // ffmpeg 的 HLS 解复用器拼接路径时不认反斜杠，这个目录下的路径统一用正斜杠手工拼
  const hlsDir = `${DIR}/hls-fmp4`;
  const hlsCat = path.join(DIR, 'hlsfmp4.single.mp4');
  if (!existsSync(hlsCat)) {
    mkdirSync(hlsDir, { recursive: true });
    ff(['-i', s, '-c', 'copy', '-hls_time', '2', '-hls_list_size', '0', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', `${hlsDir}/seg%03d.m4s`, `${hlsDir}/index.m3u8`]);
    // ffmpeg 自己解出来的参考
    run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-protocol_whitelist', 'file,crypto,data', '-allowed_extensions', 'ALL',
      '-i', `${hlsDir}/index.m3u8`, '-c', 'copy', `${hlsDir}/ref.mp4`]);
    const parts = [`${hlsDir}/init.mp4`, ...readdirSync(hlsDir).filter((f) => f.endsWith('.m4s')).sort().map((f) => `${hlsDir}/${f}`)];
    writeFileSync(hlsCat, Buffer.concat(parts.map((p) => readFileSync(p))));
  }

  // 每个用例：video + audio（两路合成），或 single（音视频本来就在一个文件里）
  const cases = [
    { label: '合成视频+合成音频', name: 'synth', video: v, audio: a },
    { label: '音视频同文件', name: 'synth', single: s },
    { label: '分片 MP4（多轨）', name: 'frag', single: frag },
    // 这个输入跨了多个分段文件，ffmpeg 不能直接读：参考用它解 HLS 得到的那个，源视频比对也用它
    { label: 'HLS 的 fMP4（初始化段 + 多个分段）', name: 'hlsfmp4', single: hlsCat, externalRef: `${hlsDir}/ref.mp4` },
  ];
  if (withYt) {
    const yv = path.join(DIR, 'yt.video.mp4');
    const ya = path.join(DIR, 'yt.audio.m4a');
    if (!existsSync(yv) || !existsSync(ya)) {
      const list = run(YTDLP, ['-F', '--no-warnings', YT_URL], { allowFail: true });
      const itag = list.status === 0 ? ['137', '136', '135', '134'].find((id) => new RegExp(`^${id}\\s`, 'm').test(list.stdout)) : null;
      assert.ok(itag, 'YouTube 视频里没有找到 H.264 的 itag 137/136/135/134:\n' + list.stdout + list.stderr);
      run(YTDLP, ['-f', itag, '--no-part', '-o', yv, YT_URL]);
      run(YTDLP, ['-f', '140', '--no-part', '-o', ya, YT_URL]);
    }
    cases.push({ label: '真实 YouTube 视频流+音频流', name: 'yt', video: yv, audio: ya });
  }
  return cases;
}

/* --------------------------------------------------- 2. JVM：我们的重封装器 */
function remuxWithOurMuxer() {
  // fixtures 目录走环境变量（见 app/build.gradle 的 testOptions），避免命令行里的反斜杠和引号问题
  const r = runGradle([':app:testDebugUnitTest', '--tests', 'com.sillyshalong.videodownloader.mp4.Mp4MuxerTest', '--no-daemon', '-q'], {
    env: { ...process.env, VD_FIXTURES: DIR },
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error('JVM 测试失败:\n' + r.stdout + r.stderr);
}

/* ------------------------------------------------------- 3. ffmpeg 逐帧比对 */
function check(c) {
  const label = c.label;
  const suffix = c.single ? '.single' : '';
  const mine = path.join(OUT, `${c.name}${suffix}.mp4`);
  assert.ok(existsSync(mine), `重封装器没有产出 ${mine}`);

  // 参考：ffmpeg 自己的无损合成（有的输入 ffmpeg 没法直接读，用事先解好的参考文件）
  const ref = path.join(OUT, `${c.name}${suffix}.ref.mp4`);
  if (c.externalRef) copyFileSync(c.externalRef, ref);
  else if (c.audio) ff(['-i', c.video, '-i', c.audio, '-c', 'copy', '-map', '0:v:0', '-map', '1:a:0', ref]);
  else ff(['-i', c.single, '-c', 'copy', ref]);

  const playable = assertPlayable(mine, { label });
  const frames = assertSameVideo(mine, ref, `${label}（对比 ffmpeg 的参考）`);
  assertSameAudio(mine, ref, `${label}：音频（对比 ffmpeg 的参考）`);
  // 音画同步：视频第一帧与音频第一个包的相对位置必须和参考一致（画面逐帧对了，音轨整体偏了也听得出来）
  const av = assertAVSync(mine, ref, label);
  // 能被 ffmpeg 直接读的源文件也各比一次
  const sourceVideo = c.video ?? (c.externalRef ? null : c.single);
  if (sourceVideo) assertSameVideo(mine, sourceVideo, `${label}（对比源视频）`);
  const sourceAudio = c.audio ?? sourceVideo;
  if (sourceAudio) assertSameAudio(mine, sourceAudio, `${label}：音频（对比源音频）`);
  // 时长：源文件开头若留了空白（空编辑），原样保留的会比参考略长一点
  const dRef = duration(probeText(ref));
  assert.ok(Math.abs(playable.duration - dRef) < 0.15, `${label}: 时长不一致（${playable.duration} vs ${dRef}）`);
  return { ...playable, frames, av };
}

/* ------------------------------------------------------------------ 主流程 */
try {
  if (!existsSync(FFMPEG)) throw new Error(`找不到 ffmpeg: ${FFMPEG}（可用环境变量 FFMPEG 指定）`);
  const cases = generate();
  remuxWithOurMuxer();
  for (const c of cases) {
    const r = check(c);
    console.log(`✔ ${c.label}: ${r.frames} 帧逐帧一致（画面哈希 + 显示时刻），音频解码一致，时长 ${r.duration.toFixed(2)}s`);
    console.log(`    音画起点：视频比音频${r.av.mine >= 0 ? '晚' : '早'} ${(Math.abs(r.av.mine) * 1000).toFixed(1)}ms（参考 ${(Math.abs(r.av.ref) * 1000).toFixed(1)}ms）`);
    for (const s of r.streams) console.log(`    ${s}`);
  }
  console.log(`\n${cases.length} 组媒体文件全部通过`);
} catch (e) {
  console.error('✖ ' + String(e.message).split('\n').map((l) => '  ' + l).join('\n'));
  process.exitCode = 1;
}
