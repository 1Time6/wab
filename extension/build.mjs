// 打包扩展：esbuild 打 4 个入口，拷贝静态文件，生成图标；--zip 生成 wab-extension.zip
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { deflateSync, deflateRawSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const mock = process.argv.includes('--mock'); // e2e 测试用：wa-js 换成模拟实现，并允许注入到本地 mock 页面
const dist = join(root, mock ? 'dist-mock' : 'dist');
const watch = process.argv.includes('--watch');
const zip = process.argv.includes('--zip') && !mock;
const MOCK_ORIGIN = 'http://127.0.0.1:3901/*';

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// ---- 简单 PNG 图标（纯色圆底 + 浅色点），无需外部依赖 ----
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function icon(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const cx = size / 2, cy = size / 2, r = size / 2 - 0.5;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const inside = d <= r;
      // 中间一个感叹号形状：竖条 + 点
      const bar = Math.abs(x + 0.5 - cx) < size * 0.09 && y > size * 0.22 && y < size * 0.6;
      const dot = Math.hypot(x + 0.5 - cx, y + 0.5 - size * 0.74) < size * 0.09;
      if (!inside) { raw[o + 3] = 0; continue; }
      if (bar || dot) { raw[o] = 255; raw[o + 1] = 255; raw[o + 2] = 255; }
      else { raw[o] = 229; raw[o + 1] = 72; raw[o + 2] = 77; }
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
for (const s of [16, 48, 128]) writeFileSync(join(dist, `icon${s}.png`), icon(s));

// ---- 静态文件 ----
if (mock) {
  const m = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  m.name += ' (MOCK)';
  m.host_permissions.push(MOCK_ORIGIN);
  for (const cs of m.content_scripts) cs.matches.push(MOCK_ORIGIN);
  writeFileSync(join(dist, 'manifest.json'), JSON.stringify(m, null, 2));
} else {
  cpSync(join(root, 'manifest.json'), join(dist, 'manifest.json'));
}
cpSync(join(root, 'src/popup.html'), join(dist, 'popup.html'));
cpSync(join(root, 'src/ui.css'), join(dist, 'ui.css'));

// ---- 打包 ----
const common = {
  bundle: true,
  format: 'iife',
  target: 'chrome110',
  sourcemap: false,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
};
const ctx = await esbuild.context({
  ...common,
  entryPoints: {
    inject: join(root, 'src/inject.ts'),
    content: join(root, 'src/content.ts'),
    background: join(root, 'src/background.ts'),
    popup: join(root, 'src/popup.ts'),
  },
  outdir: dist,
  minify: !watch && !mock,
  alias: mock ? { '@wppconnect/wa-js': join(root, 'src/mock/wa-js.ts') } : undefined,
});

if (watch) {
  await ctx.watch();
  console.log('watching…');
} else {
  await ctx.rebuild();
  await ctx.dispose();
  if (zip) {
    const out = join(root, 'wab-extension.zip');
    writeFileSync(out, zipDir(dist));
    console.log('zip →', out, `(${statSync(out).size} bytes)`);
  }
}

// ---- 纯 Node 的 zip 写入（跨平台，不依赖 zip 命令 / PowerShell）----
function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}
function walk(dir, base = '') {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push({ rel, data: readFileSync(full) });
  }
  return out;
}
function zipDir(dir) {
  const files = walk(dir);
  const locals = [], centrals = [];
  let offset = 0;
  const now = dosDateTime(new Date());
  for (const f of files) {
    const name = Buffer.from(f.rel, 'utf8');
    const comp = deflateRawSync(f.data, { level: 9 });
    const crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(now.time, 10); lh.writeUInt16LE(now.date, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(now.time, 12); ch.writeUInt16LE(now.date, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, central, end]);
}
