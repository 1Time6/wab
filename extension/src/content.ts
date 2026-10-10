/**
 * 运行在隔离世界。收 inject 的数据 → 经 background 调本机服务 → 在页面上渲染提醒。
 */
import {
  accountLabel, fmtPhone,
  STORAGE_STATE_KEY,
  type AccountInfo, type ApiRequest, type ChatInfo, type DuplicateInfo, type ExtState,
  type InjectMessage, type PopupMessage, type SyncResponse,
} from './shared.js';

const LOG = '[WAB]';

const state: ExtState = {
  wppReady: false,
  account: null,
  lastSyncAt: null,
  chatCount: 0,
  dupCount: 0,
  error: null,
};

let account: AccountInfo | null = null;
let accountAlias: string | null = null;
/** 本账号所有聊天：wid → ChatInfo */
const chatsByWid = new Map<string, ChatInfo>();
/** 重复客户：按 phone / lid 索引 */
const dupByPhone = new Map<string, DuplicateInfo>();
const dupByLid = new Map<string, DuplicateInfo>();
/** 列表标题 → DuplicateInfo（用于给 DOM 行打标） */
const dupByTitle = new Map<string, DuplicateInfo>();
/** wid → DuplicateInfo */
const dupByWid = new Map<string, DuplicateInfo>();
let activeWid: string | null = null;
let activeTitle: string | null = null;
let pendingNewChats: ChatInfo[] = [];
let flushTimer: number | null = null;

function saveState(patch: Partial<ExtState>) {
  Object.assign(state, patch);
  void chrome.storage.local.set({ [STORAGE_STATE_KEY]: state });
}

async function api<T = unknown>(method: ApiRequest['method'], path: string, body?: unknown): Promise<T> {
  const res = (await chrome.runtime.sendMessage({ type: 'WAB_API', method, path, body } satisfies ApiRequest)) as
    | { ok: boolean; status: number; data?: T; error?: string }
    | undefined;
  if (!res) throw new Error('扩展后台无响应');
  if (!res.ok) throw new Error(res.error || `服务返回 ${res.status}`);
  return res.data as T;
}

function rebuildIndexes(dups: DuplicateInfo[]) {
  dupByPhone.clear(); dupByLid.clear(); dupByTitle.clear(); dupByWid.clear();
  for (const d of dups) {
    if (d.phone) dupByPhone.set(d.phone, d);
    if (d.lid) dupByLid.set(d.lid, d);
  }
  for (const c of chatsByWid.values()) {
    const d = (c.phone && dupByPhone.get(c.phone)) || (c.lid && dupByLid.get(c.lid)) || null;
    if (d) {
      dupByWid.set(c.wid, d);
      if (c.title) dupByTitle.set(c.title, d);
    }
  }
}

async function sync(chats: ChatInfo[], reason: string) {
  if (!account) {
    saveState({ error: '尚未识别到当前 WhatsApp 账号' });
    return;
  }
  try {
    const res = await api<SyncResponse>('POST', '/api/sync', {
      account: { wid: account.wid, phone: account.phone },
      chats: chats.map((c) => ({ phone: c.phone, lid: c.lid, pushname: c.pushname, lastMsgAt: c.lastMsgAt })),
    });
    accountAlias = res.account.alias;
    rebuildIndexes(res.duplicates);
    saveState({
      account,
      accountAlias,
      lastSyncAt: new Date().toISOString(),
      lastSyncReason: reason,
      chatCount: chatsByWid.size,
      dupCount: res.duplicates.length,
      newlyDuplicated: res.newlyDuplicated.length,
      error: null,
    });
    console.log(LOG, `synced ${chats.length} chats, ${res.duplicates.length} duplicates (${reason})`);
    render();
    if (res.newlyDuplicated.length) {
      const names = res.duplicates
        .filter((d) => res.newlyDuplicated.includes(d.customerId))
        .map((d) => d.displayName || fmtPhone(d.phone) || `LID ${d.lid}`)
        .slice(0, 3)
        .join('、');
      toast(`⚠ 新发现重复客户：${names}${res.newlyDuplicated.length > 3 ? ` 等 ${res.newlyDuplicated.length} 人` : ''}`);
    }
  } catch (e) {
    const msg = (e as Error).message;
    console.warn(LOG, 'sync failed:', msg);
    saveState({ error: msg });
    render();
  }
}

function scheduleFlushNewChats() {
  if (flushTimer != null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    const batch = pendingNewChats;
    pendingNewChats = [];
    if (batch.length) void sync(batch, 'new_message');
  }, 1500);
}

// ---------- 页面渲染 ----------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dupSummary(d: DuplicateInfo): string {
  const others = d.otherAccounts.map((a) => accountLabel(a)).join('、');
  return `此客户已在账号 ${others} 出现过（首次 ${fmtDate(d.firstSeen)}）`;
}

let toastTimer: number | null = null;
function toast(text: string) {
  let t = document.getElementById('wab-toast');
  if (!t) {
    t = el('div');
    t.id = 'wab-toast';
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.classList.add('wab-show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t!.classList.remove('wab-show'), 6000);
}

/** 给聊天列表里重复客户的行打角标 */
function markListRows() {
  const pane = document.getElementById('pane-side');
  if (!pane) return;
  const rows = pane.querySelectorAll<HTMLElement>('[role="listitem"], [role="row"]');
  rows.forEach((row) => {
    const titleEl = row.querySelector<HTMLElement>('span[title]:not(.wab-badge)');
    const title = titleEl?.getAttribute('title') ?? '';
    const d = title ? dupByTitle.get(title) : undefined;
    const existing = row.querySelector<HTMLElement>('.wab-badge');
    if (d) {
      row.classList.add('wab-dup');
      if (!existing) {
        const b = el('span', 'wab-badge', '⚠');
        b.title = dupSummary(d);
        row.appendChild(b);
      } else {
        existing.title = dupSummary(d);
      }
    } else {
      row.classList.remove('wab-dup');
      existing?.remove();
    }
  });
}

/** 在当前打开的聊天顶部插横幅 */
function renderBanner() {
  const main = document.getElementById('main');
  const old = document.getElementById('wab-banner');
  if (!main) { old?.remove(); return; }

  let d: DuplicateInfo | undefined;
  if (activeWid) d = dupByWid.get(activeWid);
  if (!d) {
    // 兜底：按头部标题匹配
    const headerTitle = main.querySelector<HTMLElement>('header span[title]')?.getAttribute('title') ?? activeTitle ?? '';
    if (headerTitle) d = dupByTitle.get(headerTitle);
  }
  if (!d) { old?.remove(); return; }

  const text = dupSummary(d);
  if (old && old.dataset.customer === String(d.customerId) && old.dataset.text === text) return;
  old?.remove();

  const banner = el('div');
  banner.id = 'wab-banner';
  banner.dataset.customer = String(d.customerId);
  banner.dataset.text = text;
  banner.appendChild(el('span', 'wab-banner-icon', '⚠'));
  const body = el('div', 'wab-banner-body');
  body.appendChild(el('div', 'wab-banner-title', `重复客户：${d.displayName || fmtPhone(d.phone) || `LID ${d.lid}`}`));
  body.appendChild(el('div', 'wab-banner-text', text));
  if (d.note) body.appendChild(el('div', 'wab-banner-note', `备注：${d.note}`));
  banner.appendChild(body);
  const status = el('span', `wab-status wab-status-${d.status}`, statusLabel(d.status));
  banner.appendChild(status);
  const header = main.querySelector('header');
  if (header?.parentElement === main) header.insertAdjacentElement('afterend', banner);
  else main.prepend(banner);
}

function statusLabel(s: string): string {
  return ({ new: '新客户', following: '跟进中', won: '已成交', lost: '已流失' } as Record<string, string>)[s] ?? s;
}

/** 右下角浮动面板 */
function renderPanel() {
  let root = document.getElementById('wab-panel');
  if (!root) {
    root = el('div');
    root.id = 'wab-panel';
    document.body.appendChild(root);
  }
  const dups = [...new Map([...dupByWid.values()].map((d) => [d.customerId, d])).values()];
  const count = dups.length;
  const err = state.error;
  root.classList.toggle('wab-has-dups', count > 0);
  root.classList.toggle('wab-has-error', !!err);

  let btn = root.querySelector<HTMLElement>('.wab-panel-btn');
  if (!btn) {
    btn = el('button', 'wab-panel-btn');
    btn.addEventListener('click', () => root!.classList.toggle('wab-open'));
    root.appendChild(btn);
  }
  btn.textContent = err ? 'WAB ✕' : count ? `WAB ⚠ ${count}` : 'WAB ✓';
  btn.title = err ? `WAB：${err}` : `${accountAlias || fmtPhone(account?.phone ?? null) || '当前账号'}：${state.chatCount} 个聊天，${count} 个重复客户`;

  let list = root.querySelector<HTMLElement>('.wab-panel-list');
  if (!list) {
    list = el('div', 'wab-panel-list');
    root.appendChild(list);
  }
  list.replaceChildren();
  const head = el('div', 'wab-panel-head');
  head.appendChild(el('strong', undefined, `重复客户 ${count}`));
  const syncBtn = el('button', 'wab-panel-sync', '立即同步');
  syncBtn.addEventListener('click', () => window.postMessage({ source: 'WAB_CONTENT', type: 'SYNC_REQUEST' }, '*'));
  head.appendChild(syncBtn);
  list.appendChild(head);
  if (err) list.appendChild(el('div', 'wab-panel-error', err));
  if (!count) list.appendChild(el('div', 'wab-panel-empty', '本账号暂无与其他账号重复的客户'));
  for (const d of dups.sort((a, b) => (b.firstSeen > a.firstSeen ? 1 : -1))) {
    const item = el('div', 'wab-panel-item');
    item.appendChild(el('div', 'wab-panel-name', d.displayName || fmtPhone(d.phone) || `LID ${d.lid}`));
    item.appendChild(el('div', 'wab-panel-sub', `${d.phone ? fmtPhone(d.phone) + ' · ' : ''}也在：${d.otherAccounts.map((a) => accountLabel(a)).join('、')}`));
    const wid = [...dupByWid.entries()].find(([, v]) => v.customerId === d.customerId)?.[0];
    if (wid) item.addEventListener('click', () => window.postMessage({ source: 'WAB_CONTENT', type: 'OPEN_CHAT', payload: { wid } }, '*'));
    list.appendChild(item);
  }
  const foot = el('div', 'wab-panel-foot');
  foot.textContent = state.lastSyncAt ? `上次同步 ${new Date(state.lastSyncAt).toLocaleTimeString()}` : '尚未同步';
  list.appendChild(foot);
}

let renderScheduled = false;
function render() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    try {
      markListRows();
      renderBanner();
      renderPanel();
    } catch (e) {
      console.warn(LOG, 'render failed', e);
    }
  });
}

// 聊天列表是虚拟滚动的，行会不断重建 → 监听 DOM 变化重新打标（节流）
let moTimer: number | null = null;
const mo = new MutationObserver(() => {
  if (moTimer != null) return;
  moTimer = window.setTimeout(() => {
    moTimer = null;
    if (dupByTitle.size || document.getElementById('wab-banner')) {
      markListRows();
      renderBanner();
    }
  }, 300);
});
mo.observe(document.documentElement, { childList: true, subtree: true });

// ---------- 消息 ----------

window.addEventListener('message', (ev) => {
  if (ev.source !== window) return;
  const m = ev.data as InjectMessage;
  if (!m || m.source !== 'WAB_INJECT') return;
  switch (m.type) {
    case 'STATUS':
      saveState({ wppReady: m.payload.wppReady, wajsVersion: m.payload.wajsVersion ?? state.wajsVersion, error: m.payload.error ?? (m.payload.wppReady ? null : state.error) });
      render();
      break;
    case 'ACCOUNT':
      account = m.payload;
      saveState({ account });
      break;
    case 'CHATS':
      for (const c of m.payload.chats) chatsByWid.set(c.wid, c);
      void sync(m.payload.chats, m.payload.reason);
      break;
    case 'NEW_CHAT': {
      const c = m.payload.chat;
      chatsByWid.set(c.wid, c);
      pendingNewChats.push(c);
      scheduleFlushNewChats();
      break;
    }
    case 'ACTIVE_CHAT':
      if (m.payload.wid !== activeWid || m.payload.title !== activeTitle) {
        activeWid = m.payload.wid;
        activeTitle = m.payload.title;
        renderBanner();
      }
      break;
  }
});

chrome.runtime.onMessage.addListener((msg: PopupMessage, _s, sendResponse) => {
  if (msg?.type === 'WAB_SYNC_NOW') {
    window.postMessage({ source: 'WAB_CONTENT', type: 'SYNC_REQUEST' }, '*');
    sendResponse({ ok: true });
  } else if (msg?.type === 'WAB_GET_STATE') {
    sendResponse(state);
  }
});

saveState({});
console.log(LOG, 'content script loaded');
