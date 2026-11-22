// 验证 BiliEngine 里的手写 MD5（提取自 Kotlin 内嵌 JS）
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const kt = readFileSync('android/app/src/main/java/com/sillyshalong/videodownloader/BiliEngine.kt', 'utf8');
const m = kt.match(/function md5\(s\)[\s\S]*?return li\(o\[0\]\)\+li\(o\[1\]\)\+li\(o\[2\]\)\+li\(o\[3\]\);\}/);
if (!m) { console.log('未提取到 md5'); process.exit(1); }

// 用 Function 构造，避免 eval 作用域问题
const md5fn = new Function('s', m[0] + '; return md5(s);');

const vectors = [
  ['', 'd41d8cd98f00b204e9800998ecf8427e'],
  ['abc', '900150983cd24fb0d6963f7d28e17f72'],
  ['hello world', '5eb63bbbe01eeed093cb22bb8f5acdc3'],
  ['中文测试内容-长字符串-with-english-mixed-1234567890', null],
  ['The quick brown fox jumps over the lazy dog', '9e107d9d372bb6826bd81d3542a419d6'],
];

let pass = 0, fail = 0;
for (const [input, expected] of vectors) {
  let got;
  try { got = md5fn(input); } catch (e) { got = 'THROW: ' + e.message; }
  const exp = expected || createHash('md5').update(input, 'utf8').digest('hex');
  if (got === exp) { pass++; console.log('PASS:', JSON.stringify(input.slice(0, 30))); }
  else { fail++; console.log('FAIL:', JSON.stringify(input.slice(0, 30)), '| got', got, '| want', exp); }
}
console.log('结果:', pass, '过 /', fail, '败');
