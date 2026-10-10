/**
 * 扩展端到端测试：真实 Chrome + 真实服务端 + 模拟的 WhatsApp Web 页面。
 * 运行：npm run e2e -w extension   （需要本机装有 Google Chrome）
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = join(here, '..');
const repoRoot = join(extRoot, '..');
const distMock = join(extRoot, 'dist-mock');
const SERVER_PORT = 3900;
const MOCK_PORT = 3901;

// 正式版 Google Chrome 从 137 起忽略 --load-extension，必须用 Chrome for Testing / Chromium。
// 优先：CHROME_PATH 环境变量 → Playwright 缓存里的 Chrome for Testing → puppeteer 缓存 → 系统 Chromium。
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
function findInCache(base, globs) {
  try {
    for (const d of readdirSync(base).sort().reverse()) {
      for (const g of globs) { const p = join(base, d, g); if (existsSync(p)) return p; }
    }
  } catch {}
  return null;
}
const home = homedir();
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  findInCache(join(home, 'Library/Caches/ms-playwright'), [
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
  ]),
  findInCache(join(home, 'AppData/Local/ms-playwright'), ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe']),
  findInCache(join(home, '.cache/puppeteer/chrome'), [
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-win64/chrome.exe', 'chrome-linux64/chrome',
  ]),
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);
const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.error('找不到 Chrome for Testing / Chromium。正式版 Chrome 不能加载未打包扩展。');
  console.error('安装：npx @puppeteer/browsers install chrome@stable   然后重跑（或用 CHROME_PATH 指定）');
  process.exit(2);
}
console.log('浏览器：', chromePath);
if (!existsSync(distMock)) { console.error('先执行 node build.mjs --mock'); process.exit(2); }

// ---------- 小工具 ----------
let failures = 0;
function check(cond, msg) {
  if (cond) console.log('  ✔', msg);
  else { failures++; console.log('  ✘', msg); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 15000, interval = 200, label = 'condition' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label}`);
}
function portFree(port) {
  return new Promise((res) => {
    const s = net.createServer().once('error', () => res(false)).once('listening', () => s.close(() => res(true))).listen(port, '127.0.0.1');
  });
}
async function api(path, init) {
  const r = await fetch(`http://127.0.0.1:${SERVER_PORT}${path}`, init);
  return r.json();
}

// ---------- 1. 启动服务端（临时数据库） ----------
if (!(await portFree(SERVER_PORT))) { console.error(`端口 ${SERVER_PORT} 被占用，先停掉正在运行的 WAB 服务`); process.exit(2); }
const tmp = mkdtempSync(join(tmpdir(), 'wab-e2e-'));
const server = spawn(process.execPath, ['--import', 'tsx', join(repoRoot, 'server/src/index.ts')], {
  cwd: repoRoot,
  env: { ...process.env, WAB_PORT: String(SERVER_PORT), WAB_DB: join(tmp, 'e2e.db'), WAB_NOTIFY: '0', WAB_LOG: 'warn', NODE_NO_WARNINGS: '1' },
  stdio: ['ignore', 'inherit', 'inherit'],
});
await waitFor(() => api('/api/health').then((r) => r.ok), { label: 'server health' });
console.log('服务端已启动');

// ---------- 2. 静态服务托管 mock 页面 ----------
const mockHtml = readFileSync(join(extRoot, 'mock/index.html'));
const mockServer = createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(mockHtml); });
await new Promise((r) => mockServer.listen(MOCK_PORT, '127.0.0.1', r));

// ---------- 3. 启动 Chrome 并加载扩展 ----------
const userDataDir = join(tmp, 'profile');
mkdirSync(userDataDir);
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: process.env.E2E_HEADFUL ? false : true,
  userDataDir,
  args: [`--disable-extensions-except=${distMock}`, `--load-extension=${distMock}`, '--no-first-run', '--no-default-browser-check'],
});
const pageLogs = [];
function attachLogs(page, tag) {
  page.on('console', (m) => { const t = `[${tag}] ${m.type()}: ${m.text()}`; pageLogs.push(t); if (process.env.E2E_VERBOSE) console.log(t); });
  page.on('pageerror', (e) => pageLogs.push(`[${tag}] pageerror: ${e.message}`));
}
const shotDir = join(extRoot, 'test/screenshots');
mkdirSync(shotDir, { recursive: true });

let exitCode = 1;
try {
  const panelText = (page) => page.$eval('#wab-panel .wab-panel-btn', (b) => b.textContent).catch(() => null);

  // ---------- 场景 A：账号一，3 个私聊 + 1 个群 ----------
  console.log('\n场景 A：账号一首次同步');
  const pageA = await browser.newPage();
  attachLogs(pageA, 'A');
  await pageA.goto(`http://127.0.0.1:${MOCK_PORT}/?scenario=a`);
  const btnA = await waitFor(async () => { const t = await panelText(pageA); return t && !t.includes('…') && t !== 'WAB ✓' && t !== 'WAB ⚠' ? t : (t === 'WAB ✓' ? t : null); }, { label: 'A 面板出现' });
  check(btnA === 'WAB ✓', `面板按钮显示无重复：${btnA}`);
  const accounts = await api('/api/accounts');
  check(accounts.length === 1 && accounts[0].wid === '8613900000001@c.us', '服务端记录了账号一');
  check(accounts[0].customer_count === 3, `上报了 3 个私聊，群被忽略（实际 ${accounts[0].customer_count}）`);
  const jerryA = await api('/api/check?lid=99887766554433');
  check(jerryA.found && jerryA.customer.phone === null, 'Jerry 以纯 LID 记录（账号一查不到号码）');
  check((await pageA.$$('.wab-badge')).length === 0, '账号一页面没有角标');

  // ---------- 场景 B：账号二，Tom 重复（已保存名字）、Jerry 通过 LID→号码 反查后重复 ----------
  console.log('\n场景 B：账号二同步，发现重复');
  const pageB = await browser.newPage();
  attachLogs(pageB, 'B');
  await pageB.goto(`http://127.0.0.1:${MOCK_PORT}/?scenario=b`);
  const btnB = await waitFor(async () => { const t = await panelText(pageB); return t && t.startsWith('WAB ⚠') ? t : null; }, { label: 'B 面板显示重复' });
  check(btnB === 'WAB ⚠ 2', `面板按钮显示 2 个重复：${btnB}`);
  const badges = await pageB.$$eval('[role="listitem"].wab-dup span[title]:not(.wab-badge)', (els) => els.map((e) => e.title));
  check(badges.length === 2 && badges.includes('老汤（已保存）') && badges.includes('Jerry'), `角标打在正确的行上（按列表标题匹配，包含已保存联系人名）：${JSON.stringify(badges)}`);
  const jerry = await api('/api/check?lid=99887766554433');
  check(jerry.customer.phone === '5511999990000' && jerry.customer.otherAccounts.length === 2, 'Jerry 的 LID 记录与反查出的号码合并，出现在 2 个账号');
  const stats = await api('/api/stats');
  check(stats.customers === 4 && stats.duplicates === 2, `服务端统计：客户 ${stats.customers}（期望 4）重复 ${stats.duplicates}（期望 2）`);

  console.log('\n场景 B：打开重复客户的聊天 → 横幅');
  await pageB.evaluate(() => window.mockOpen('8613800138000@c.us'));
  const bannerText = await waitFor(() => pageB.$eval('#wab-banner', (b) => b.textContent), { label: '横幅出现' });
  check(bannerText.includes('+8613900000001') && bannerText.includes('重复客户'), `横幅内容：${bannerText.trim().slice(0, 80)}`);
  await pageB.screenshot({ path: join(shotDir, 'b-banner.png') });

  await pageB.evaluate(() => window.mockOpen('447700900123@c.us'));
  await waitFor(async () => !(await pageB.$('#wab-banner')), { label: '横幅消失' });
  check(true, '切到非重复客户 Bob，横幅消失');

  console.log('\n场景 B：新消息即时查重');
  await pageB.evaluate(() => window.mockNewMessage('14155550123@c.us', 'Ann'));
  const toast = await waitFor(async () => { const t = await pageB.$eval('#wab-toast.wab-show', (t) => t.textContent); return t.includes('Ann') ? t : null; }, { label: '包含 Ann 的 toast' });
  check(toast.includes('新发现重复客户'), `toast：${toast}`);
  const btnB2 = await waitFor(async () => { const t = await panelText(pageB); return t === 'WAB ⚠ 3' ? t : null; }, { label: '面板计数变为 3' });
  check(btnB2 === 'WAB ⚠ 3', '新消息来自账号一已有的客户 Ann → 面板计数变 3');
  const annBadge = await pageB.$$eval('[role="listitem"].wab-dup span[title]:not(.wab-badge)', (els) => els.map((e) => e.title));
  check(annBadge.includes('Ann'), `Ann 的行立即打上角标：${JSON.stringify(annBadge)}`);

  console.log('\n场景 B：浮动面板');
  await pageB.click('#wab-panel .wab-panel-btn');
  const items = await pageB.$$eval('.wab-panel-item .wab-panel-name', (els) => els.map((e) => e.textContent));
  check(items.length === 3, `面板列出 3 个重复客户：${JSON.stringify(items)}`);
  await pageB.screenshot({ path: join(shotDir, 'b-panel.png') });
  const jerryItem = (await pageB.$$('.wab-panel-item')).at(items.indexOf('Jerry'));
  await jerryItem.click();
  const banner2 = await waitFor(() => pageB.$eval('#wab-banner', (b) => b.textContent), { label: '点面板项打开 Jerry' });
  check(banner2.includes('Jerry'), '点击面板项跳转到该聊天并显示横幅');

  console.log('\n扩展存储状态（popup 读取的数据）');
  const sw = await waitFor(async () => (await browser.targets()).find((t) => t.type() === 'service_worker'), { label: 'service worker' });
  const worker = await sw.worker();
  const st = await worker.evaluate(() => chrome.storage.local.get('wab_state').then((r) => r.wab_state));
  check(st?.wppReady === true && st?.account?.wid && st?.dupCount === 3 && !st?.error, `wab_state：account=${st?.account?.wid} chats=${st?.chatCount} dups=${st?.dupCount} error=${st?.error}`);

  console.log('\n账号一回看：Ann 现在也应标为重复');
  await pageA.bringToFront();
  await pageA.evaluate(() => window.postMessage({ source: 'WAB_CONTENT', type: 'SYNC_REQUEST' }, '*'));
  const btnA2 = await waitFor(async () => { const t = await panelText(pageA); return t === 'WAB ⚠ 3' ? t : null; }, { label: 'A 面板计数 3' });
  check(btnA2 === 'WAB ⚠ 3', '账号一手动同步后看到 3 个重复（Tom、Jerry、Ann）');

  exitCode = failures ? 1 : 0;
} catch (e) {
  console.error('\n✘ 测试中断：', e.message);
  console.error(pageLogs.slice(-30).join('\n'));
  exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  mockServer.close();
  server.kill();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(exitCode ? `\n失败（${failures} 项断言失败${failures ? '' : '，测试中断'}）` : '\n全部通过');
if (!failures && pageLogs.some((l) => /error/i.test(l) && !/favicon/.test(l))) {
  console.log('\n页面控制台里的错误（不影响断言，供排查）：');
  console.log(pageLogs.filter((l) => /error/i.test(l)).join('\n'));
}
process.exit(exitCode);
