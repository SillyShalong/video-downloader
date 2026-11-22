// 单元测试：纯逻辑（站点识别、URL 抽取、参数构建、配置校验、explorer 参数）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchSite, extractUrls } from '../src/sites.mjs';
import { buildArgs } from '../src/downloader.mjs';
import { isValidProxy } from '../src/config.mjs';
import { buildExplorerArgs } from '../src/server.mjs';

// ---------- 站点识别 ----------
test('matchSite: YouTube 各域名', () => {
  for (const u of [
    'https://www.youtube.com/watch?v=x',
    'https://youtu.be/x',
    'https://m.youtube.com/shorts/x',
    'https://music.youtube.com/watch?v=x',
    'https://www.youtube-nocookie.com/embed/x',
  ]) {
    assert.equal(matchSite(u)?.id, 'youtube', u);
  }
});

test('matchSite: 抖音各域名', () => {
  for (const u of ['https://v.douyin.com/abc/', 'https://www.douyin.com/video/123', 'https://www.iesdouyin.com/x']) {
    assert.equal(matchSite(u)?.id, 'douyin', u);
  }
});

test('matchSite: B站各域名（含 b23.tv 短链）', () => {
  for (const u of [
    'https://www.bilibili.com/video/BV1GJ411x7h7',
    'https://bilibili.com/video/BV1xx411c7mD',
    'https://m.bilibili.com/video/BV1GJ411x7h7',
    'https://b23.tv/xxxxxxx',
  ]) {
    assert.equal(matchSite(u)?.id, 'bilibili', u);
  }
});

test('matchSite: 其他站点为 null（走 yt-dlp 默认）', () => {
  assert.equal(matchSite('https://vimeo.com/123456'), null);
  assert.equal(matchSite('不是链接'), null);
});

// ---------- 分享口令 URL 抽取 ----------
test('extractUrls: 抖音分享口令', () => {
  const text = '0.56 复制打开抖音，看看【xx的作品】... https://v.douyin.com/YS81GPkMQ8M/ 12/28 :4pm hbA:/ m@d.NJ';
  assert.deepEqual(extractUrls(text), ['https://v.douyin.com/YS81GPkMQ8M/']);
});

test('extractUrls: 多条链接与去尾标点', () => {
  const urls = extractUrls('看 https://a.com/x 和 https://b.com/y。完');
  assert.deepEqual(urls, ['https://a.com/x', 'https://b.com/y']);
});

test('extractUrls: 无链接返回空数组', () => {
  assert.deepEqual(extractUrls('纯文本没有链接'), []);
});

// ---------- yt-dlp 参数构建 ----------
test('buildArgs: 基础参数（编码、打印、输出模板、重试）', () => {
  const args = buildArgs('https://youtu.be/x', { outDir: 'D:/out' });
  assert.ok(args.includes('--encoding'));
  assert.ok(args.includes('utf-8'));
  assert.ok(args.some((a, i) => a === '--print' && args[i + 1] === 'after_move:%(filepath)s'));
  assert.ok(args.some((a, i) => a === '--print' && args[i + 1] === 'before_dl:__TITLE__%(title)s'));
  assert.ok(args.includes('--no-simulate'));
  assert.ok(args.join(' ').includes('D:\\out') || args.join(' ').includes('D:/out'));
  assert.ok(args.includes('--extractor-retries'));
});

test('buildArgs: YouTube 默认锁定 avc1（H.264 兼容）', () => {
  const args = buildArgs('https://youtu.be/x', {});
  const i = args.indexOf('-f');
  assert.ok(args[i + 1].includes('vcodec^=avc1'), '必须显式锁定 avc1');
});

test('buildArgs: B站同样锁定 avc1（避开 av01/hev1 兼容坑）', () => {
  const args = buildArgs('https://www.bilibili.com/video/BV1GJ411x7h7', {});
  assert.ok(args[args.indexOf('-f') + 1].includes('vcodec^=avc1'));
});

test('buildArgs: B站 SESSDATA 注入 Cookie；其他站点不注入', () => {
  const args = buildArgs('https://www.bilibili.com/video/BV1GJ411x7h7', { bilibiliSessdata: 'abc%2C123' });
  const i = args.indexOf('--add-headers');
  assert.equal(args[i + 1], 'Cookie: SESSDATA=abc%2C123');
  // YouTube 链接即使传了也不应注入
  const ytArgs = buildArgs('https://youtu.be/x', { bilibiliSessdata: 'abc%2C123' });
  assert.equal(ytArgs.indexOf('--add-headers'), -1);
  // 未提供 SESSDATA 不注入
  assert.equal(buildArgs('https://www.bilibili.com/video/BV1xx', {}).indexOf('--add-headers'), -1);
});

test('buildArgs: 代理透传', () => {
  const args = buildArgs('https://youtu.be/x', { proxy: 'socks5://127.0.0.1:1080' });
  const i = args.indexOf('--proxy');
  assert.equal(args[i + 1], 'socks5://127.0.0.1:1080');
  // 未配置代理时不应有 --proxy
  assert.equal(buildArgs('https://youtu.be/x', {}).indexOf('--proxy'), -1);
});

test('buildArgs: 清晰度限制映射为 height<=N 且保持 avc1 优先', () => {
  const args = buildArgs('https://youtu.be/x', { quality: '720' });
  const fmt = args[args.indexOf('-f') + 1];
  assert.ok(fmt.includes('height<=720'));
  assert.ok(fmt.includes('vcodec^=avc1'));
});

test('buildArgs: 仅音频走 -x mp3', () => {
  const args = buildArgs('https://youtu.be/x', { audioOnly: true });
  assert.ok(args.includes('-x'));
  assert.equal(args[args.indexOf('--audio-format') + 1], 'mp3');
});

// ---------- 代理地址校验 ----------
test('isValidProxy: 合法与非法', () => {
  for (const ok of ['', 'http://127.0.0.1:7890', 'https://p.example.com:8080', 'socks5://1.2.3.4:1080', 'socks5h://a:1', 'socks4://a:1']) {
    assert.equal(isValidProxy(ok), true, ok);
  }
  for (const bad of ['127.0.0.1:7890', 'ftp://x', 'http://', 'javascript:alert(1)', 'abc']) {
    assert.equal(isValidProxy(bad), false, bad);
  }
});

// ---------- explorer 参数（回归：含空格路径不能整段加引号） ----------
test('buildExplorerArgs: 文件 → /select,"路径"，引号仅包路径', () => {
  const [arg] = buildExplorerArgs('C:\\dl\\POV： Buying GPU 💀 [id].mp4', false);
  assert.equal(arg, '/select,"C:\\dl\\POV： Buying GPU 💀 [id].mp4"');
  assert.ok(arg.startsWith('/select,"'));
  assert.ok(arg.endsWith('"'));
  // 关键断言：引号内不能再有 /select, 前缀（之前 bug 是整段被包引号）
  assert.ok(!arg.startsWith('"/select'));
});

test('buildExplorerArgs: 目录直接打开；路径中的引号被剥离', () => {
  const [dirArg] = buildExplorerArgs('C:\\my dir', true);
  assert.equal(dirArg, '"C:\\my dir"');
  const [clean] = buildExplorerArgs('C:\\a"b\\c.mp4', false);
  assert.equal(clean, '/select,"C:\\ab\\c.mp4"');
});
