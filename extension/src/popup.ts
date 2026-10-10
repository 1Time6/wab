import { DEFAULT_SERVER, STORAGE_SERVER_KEY, STORAGE_STATE_KEY, fmtPhone, getServerUrl, type ExtState } from './shared.js';

const $ = (id: string) => document.getElementById(id)!;

async function activeWhatsAppTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url?.startsWith('https://web.whatsapp.com') ? tab : undefined;
}

function renderState(s: ExtState | undefined) {
  if (!s) {
    $('wpp').textContent = '未打开 WhatsApp Web';
    $('wpp').className = 'warn';
    return;
  }
  $('wpp').textContent = s.wppReady ? '已就绪' : '加载中…';
  $('wpp').className = s.wppReady ? 'ok' : 'warn';
  const acc = s.account;
  $('account').textContent = acc ? `${s.accountAlias ? s.accountAlias + ' ' : ''}${fmtPhone(acc.phone) || acc.wid}` : '—';
  $('chats').textContent = String(s.chatCount ?? 0);
  $('dups').textContent = String(s.dupCount ?? 0);
  $('dups').className = s.dupCount ? 'bad' : 'ok';
  $('last').textContent = s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString() : '尚未同步';
  const err = $('error');
  if (s.error) { err.textContent = s.error; err.hidden = false; } else err.hidden = true;
}

async function load() {
  const server = await getServerUrl();
  ($('server') as HTMLInputElement).value = server === DEFAULT_SERVER ? '' : server;
  const tab = await activeWhatsAppTab();
  let s: ExtState | undefined;
  if (tab?.id) {
    try { s = await chrome.tabs.sendMessage(tab.id, { type: 'WAB_GET_STATE' }); } catch {}
  }
  if (!s) {
    const r = await chrome.storage.local.get(STORAGE_STATE_KEY);
    s = r[STORAGE_STATE_KEY] as ExtState | undefined;
    if (!tab) { renderState(undefined); if (s) renderState(s); return; }
  }
  renderState(s);
}

$('sync').addEventListener('click', async () => {
  const tab = await activeWhatsAppTab();
  if (!tab?.id) { alert('请先切换到 WhatsApp Web 标签页'); return; }
  await chrome.tabs.sendMessage(tab.id, { type: 'WAB_SYNC_NOW' }).catch(() => {});
  setTimeout(load, 1500);
});

$('open').addEventListener('click', async () => {
  chrome.tabs.create({ url: await getServerUrl() });
});

let saveTimer: number | undefined;
$('server').addEventListener('input', () => {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const v = ($('server') as HTMLInputElement).value.trim();
    chrome.storage.local.set({ [STORAGE_SERVER_KEY]: v || DEFAULT_SERVER });
  }, 400);
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes[STORAGE_STATE_KEY]) renderState(changes[STORAGE_STATE_KEY].newValue as ExtState);
});

void load();
