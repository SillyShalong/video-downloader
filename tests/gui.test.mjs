// GUI 回归测试：playwright-core + 系统 Edge 无头模式，驱动真实页面（React + AntD）
// 覆盖历史出过 bug 的路径：弹窗显隐、explorer 定位、任务流、防闪烁
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

// 隔离配置（须在导入业务模块前设置）
const tmpRoot = mkdtempSync(path.join(tmpdir(), 'vd-gui-'));
process.env.VD_CONFIG_PATH = path.join(tmpRoot, 'config.json');
writeFileSync(process.env.VD_CONFIG_PATH, JSON.stringify({ proxy: '' }));
process.env.VD_HISTORY_PATH = path.join(tmpRoot, 'history.json');

const { createApp } = await import('../src/server.mjs');
const server = createApp();
await new Promise((res) => server.listen(0, '127.0.0.1', res));
const BASE = `http://127.0.0.1:${server.address().port}`;

// 本地视频桩（flaky.mp4 配合 flakyFail 开关模拟瞬时失败；slow.mp4 分块慢发用于进度流）
const stubBody = Buffer.from('FAKE-MP4-FOR-GUI-E2E');
const slowBody = Buffer.alloc(100);
let flakyFail = true;
const stub = http.createServer((req, res) => {
  if (req.url === '/flaky.mp4' && flakyFail) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('simulated failure');
    return;
  }
  if (req.url === '/slow.mp4') {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(slowBody.length) });
    let i = 0;
    const timer = setInterval(() => {
      res.write(slowBody.subarray(0, 10));
      if (++i >= 10) {
        clearInterval(timer);
        res.end();
      }
    }, 300);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(stubBody.length) });
  res.end(stubBody);
});
await new Promise((res) => stub.listen(0, '127.0.0.1', res));
const STUB_URL = `http://127.0.0.1:${stub.address().port}/fake.mp4`;
const FLAKY_URL = `http://127.0.0.1:${stub.address().port}/flaky.mp4`;
const SLOW_URL = `http://127.0.0.1:${stub.address().port}/slow.mp4`;

// 启动无头 Edge（缺 Edge 时整文件跳过）
let browser, page;
try {
  const { chromium } = await import('playwright-core');
  browser = await chromium.launch({ channel: 'msedge', headless: true });
} catch (err) {
  console.warn('跳过 GUI 测试（无法启动 Edge）:', err.message);
}

test.after(() => {
  browser?.close();
  server.close();
  server.closeAllConnections?.(); // 页面里的 SSE 长连接会挂住 close()
  stub.close();
  stub.closeAllConnections?.();
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** AntD Modal 关闭后 DOM 可能保留（隐藏），以 wrap 的可见性为准 */
const modalVisible = () =>
  page.evaluate(() => {
    const w = document.querySelector('.ant-modal-wrap');
    return !!w && getComputedStyle(w).display !== 'none';
  });

test('GUI: 页面加载', { skip: !browser }, async () => {
  page = await browser.newPage({ viewport: { width: 1100, height: 860 } });
  await page.goto(BASE + '/');
  await page.waitForSelector('#dir-browse');
  assert.ok((await page.title()) === 'Video Downloader');
});

test('GUI[回归]: 目录弹窗初始不可见', { skip: !browser }, async () => {
  assert.equal(await modalVisible(), false);
});

test('GUI[回归]: 弹窗打开后 ×/取消/Esc/遮罩 四种方式都能真正关闭', { skip: !browser }, async () => {
  // × 关闭
  await page.click('#dir-browse');
  await page.waitForFunction(() => !!document.querySelector('.ant-modal-wrap') && getComputedStyle(document.querySelector('.ant-modal-wrap')).display !== 'none');
  await page.click('.ant-modal-close');
  await page.waitForFunction(() => !document.querySelector('.ant-modal-wrap') || getComputedStyle(document.querySelector('.ant-modal-wrap')).display === 'none');
  assert.equal(await modalVisible(), false, '× 应关闭');

  // 取消
  await page.click('#dir-browse');
  await page.waitForFunction(() => !!document.querySelector('.ant-modal-wrap') && getComputedStyle(document.querySelector('.ant-modal-wrap')).display !== 'none');
  await page.click('#dm-cancel');
  await page.waitForFunction(() => !document.querySelector('.ant-modal-wrap') || getComputedStyle(document.querySelector('.ant-modal-wrap')).display === 'none');
  assert.equal(await modalVisible(), false, '取消应关闭');

  // Esc
  await page.click('#dir-browse');
  await page.waitForFunction(() => !!document.querySelector('.ant-modal-wrap') && getComputedStyle(document.querySelector('.ant-modal-wrap')).display !== 'none');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.ant-modal-wrap') || getComputedStyle(document.querySelector('.ant-modal-wrap')).display === 'none');
  assert.equal(await modalVisible(), false, 'Esc 应关闭');

  // 点遮罩（点在弹窗外的角落）
  await page.click('#dir-browse');
  await page.waitForFunction(() => !!document.querySelector('.ant-modal-wrap') && getComputedStyle(document.querySelector('.ant-modal-wrap')).display !== 'none');
  await page.mouse.click(15, 120);
  await page.waitForFunction(() => !document.querySelector('.ant-modal-wrap') || getComputedStyle(document.querySelector('.ant-modal-wrap')).display === 'none');
  assert.equal(await modalVisible(), false, '点遮罩应关闭');
});

test('GUI: 目录弹窗可导航并确认回填', { skip: !browser }, async () => {
  await page.click('#dir-browse');
  await page.waitForSelector('.dm-item');
  await page.click('.dm-item:has-text("主目录")');
  await page.waitForFunction(() => document.getElementById('dm-path').textContent.includes('Users'));
  assert.ok((await page.locator('.dm-item').count()) > 0, '主目录下应有目录项');
  // 上级按钮：C:\Users\lijialun → C:\Users（上级仍含 "Users"，断言用用户名）
  await page.click('#dm-up');
  await page.waitForFunction(() => !document.getElementById('dm-path').textContent.includes('lijialun'));
  // 🏠 主目录按钮回到 home 再确认
  await page.click('#dm-home');
  await page.waitForFunction(() => document.getElementById('dm-path').textContent.includes('Users'));
  await page.click('#dm-ok');
  // antd Modal 关闭有动画，等待 wrap 隐藏完成
  await page.waitForFunction(() => !document.querySelector('.ant-modal-wrap') || getComputedStyle(document.querySelector('.ant-modal-wrap')).display === 'none');
  assert.equal(await modalVisible(), false);
  const val = await page.inputValue('#outdir');
  assert.ok(/[A-Z]:\\Users/.test(val), '回填绝对路径: ' + val);
});

test('GUI: 抖音口令识别徽章 + 仅音频自动禁用', { skip: !browser }, async () => {
  await page.fill('#input', '0.56 复制打开抖音，看看【xx】... https://v.douyin.com/ABC123/ 12/28');
  // 等 parse 防抖(350ms)完成后的最终态徽章（任意 .ant-tag 会先匹配到"未识别到链接"过渡态）
  await page.waitForSelector('.detected .ant-tag:has-text("抖音")', { timeout: 5000 });
  assert.ok(await page.isDisabled('#audio'), '抖音应禁用仅音频');
  await page.fill('#input', '');
});

test('GUI: 清晰度分段选择', { skip: !browser }, async () => {
  await page.click('#quality label:has-text("720p")');
  // antd v6 选中类名为 ant-segmented-item-selected-text，隐藏 radio 无 value
  assert.ok(
    await page.locator('#quality .ant-segmented-item[class*="selected"]:has-text("720p")').count(),
    '720p 应为选中态',
  );
});

test('GUI: 设置面板开关', { skip: !browser }, async () => {
  await page.click('#gear');
  assert.ok(await page.evaluate(() => document.getElementById('settings').classList.contains('open')));
  await page.click('#gear');
  assert.ok(!(await page.evaluate(() => document.getElementById('settings').classList.contains('open'))));
});

test('GUI: 端到端下载任务 → 任务卡完成', { skip: !browser, timeout: 60000 }, async () => {
  await page.fill('#input', STUB_URL);
  await page.click('#btn');
  await page.waitForSelector('.ant-message-notice', { timeout: 5000 });
  await page.waitForSelector('.sticon.done', { timeout: 30000 });
  const file = await page.textContent('.task .file');
  assert.ok(file.includes('.mp4'), '任务卡应显示文件名: ' + file);
  assert.ok((await page.locator('.task button[data-act="open"]').count()) >= 1, '应有「打开文件」按钮');
});

test('GUI: 失败任务重试按钮 → 点按后成功', { skip: !browser, timeout: 120000 }, async () => {
  flakyFail = true;
  await page.fill('#input', FLAKY_URL);
  await page.click('#btn');
  await page.waitForSelector('.task.error', { timeout: 60000 });
  // .actions 有 opacity transition(0.16s)，等过渡完成再断言
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.task.error .actions')).opacity === '1');
  assert.ok(true, '失败卡重试按钮常显');
  flakyFail = false;
  await page.click('.task.error button[data-act="retry"]');
  // 必须等 done（只等"非 error"会在 running 状态提前通过，污染后续测试）
  await page.waitForFunction(
    () => {
      const first = document.querySelector('.task');
      if (!first || !first.classList.contains('done')) return false;
      const txt = (first.querySelector('.file')?.textContent || '') + (first.querySelector('.title')?.textContent || '');
      return txt.includes('flaky');
    },
    { timeout: 30000 },
  );
  assert.equal(await page.locator('.task.error').count(), 0, '失败卡应已被复位');
});

test('GUI[回归]: 下载中任务卡不整卡重建（防闪烁）', { skip: !browser, timeout: 90000 }, async () => {
  await page.fill('#input', SLOW_URL);
  await page.click('#btn');
  // 必须锁定 slow 任务本身（页面上可能有其他任务处于 running）
  await page.waitForFunction(
    () => [...document.querySelectorAll('.task.running')].some((e) => e.textContent.includes('slow')),
    { timeout: 20000 },
  );
  await page.waitForTimeout(300); // 等列表稳定（提交瞬间的状态抖动）
  await page.evaluate(() => {
    window.__card = [...document.querySelectorAll('.task')].find((e) => e.textContent.includes('slow'));
  });
  await page.waitForTimeout(1600);
  const sameNode = await page.evaluate(
    () => [...document.querySelectorAll('.task')].find((e) => e.textContent.includes('slow')) === window.__card,
  );
  assert.equal(sameNode, true, '进度更新不应重建任务卡 DOM（会闪烁）');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.task.done')].some((e) => e.textContent.includes('slow')),
    { timeout: 30000 },
  );
});
