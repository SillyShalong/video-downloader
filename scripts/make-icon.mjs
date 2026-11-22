// 生成应用图标：SVG 设计稿 → resvg 渲染多尺寸 PNG → 打包多尺寸 .ico（Vista+ 格式：PNG 直存）
// 产物：build/icon.ico（exe/任务栏/快捷方式）、docs/icon.png（README）、web/src/assets/logo.svg（界面 Logo 同源）
import { Resvg } from '@resvg/resvg-js';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 与界面品牌一致的渐变（蓝 → 靛 → 紫），圆角磁贴 + 白色圆头下载箭头（箭头兼有"播放三角"意象）
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7aa7ff"/>
      <stop offset="0.45" stop-color="#5b8cff"/>
      <stop offset="1" stop-color="#8b5cf6"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.30"/>
      <stop offset="0.45" stop-color="#ffffff" stop-opacity="0.05"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <filter id="soft" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#1b3b8f" flood-opacity="0.35"/>
    </filter>
  </defs>

  <rect x="32" y="32" width="960" height="960" rx="226" fill="url(#bg)"/>
  <rect x="32" y="32" width="960" height="960" rx="226" fill="url(#sheen)"/>

  <g filter="url(#soft)">
    <g stroke="#ffffff" stroke-width="94" stroke-linecap="round" stroke-linejoin="round" fill="none">
      <path d="M512 296 L512 556"/>
      <path d="M356 496 L512 652 L668 496"/>
      <path d="M366 766 L658 766"/>
    </g>
  </g>
</svg>`;

// 仅白色图形（界面 Logo 内联用，磁贴底色由 CSS 渐变提供）
const GLYPH_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <g stroke="#ffffff" stroke-width="94" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M512 296 L512 556"/>
    <path d="M356 496 L512 652 L668 496"/>
    <path d="M366 766 L658 766"/>
  </g>
</svg>`;

const render = (size) =>
  new Resvg(SVG, { fitTo: { mode: 'width', width: size } }).render().asPng();

/** PNG 缓冲列表 → 多尺寸 ICO（目录项 + 原样 PNG 数据；256px 宽度按约定写 0） */
function packIco(pngBuffers) {
  const n = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(n, 4);
  const entries = Buffer.alloc(16 * n);
  let offset = header.length + entries.length;
  const parts = [header, entries];
  pngBuffers.forEach((png, i) => {
    const dim = PNG_DIMS[i] ?? 0;
    const base = i * 16;
    entries.writeUInt8(dim >= 256 ? 0 : dim, base); // 宽（256 写 0）
    entries.writeUInt8(dim >= 256 ? 0 : dim, base + 1); // 高
    entries.writeUInt8(0, base + 2); // 调色板数
    entries.writeUInt8(0, base + 3); // reserved
    entries.writeUInt16LE(1, base + 4); // planes
    entries.writeUInt16LE(32, base + 6); // bpp
    entries.writeUInt32LE(png.length, base + 8);
    entries.writeUInt32LE(offset, base + 12);
    offset += png.length;
    parts.push(png);
  });
  return Buffer.concat(parts);
}

const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const PNG_DIMS = sizes;
const pngs = sizes.map(render);

mkdirSync(path.join(ROOT, 'build'), { recursive: true });
mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
mkdirSync(path.join(ROOT, 'web', 'src', 'assets'), { recursive: true });

writeFileSync(path.join(ROOT, 'build', 'icon.ico'), packIco(pngs));
writeFileSync(path.join(ROOT, 'docs', 'icon.png'), render(256));
writeFileSync(path.join(ROOT, 'web', 'src', 'assets', 'logo.svg'), GLYPH_SVG);
console.log(`icon.ico (${sizes.join('/')}px, ${pngs.length} 层) + docs/icon.png + logo.svg 已生成`);
