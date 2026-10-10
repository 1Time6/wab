/**
 * 运行在 web.whatsapp.com 的页面主世界（MAIN world）。
 * 职责：加载 wa-js，读取当前账号与聊天列表，监听新消息 / 当前打开的聊天，
 * 通过 window.postMessage 把数据交给 content.ts（隔离世界）。
 * 本脚本只读，不发送任何消息，不修改任何聊天。
 */
import './wppconfig.js';
import * as WPP from '@wppconnect/wa-js';
import type { AccountInfo, ChatInfo, ContentMessage, InjectMessage } from './shared.js';

const LOG = '[WAB inject]';
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

type AnyObj = Record<string, any>;

function post(msg: Omit<InjectMessage, 'source'>) {
  window.postMessage({ source: 'WAB_INJECT', ...msg }, '*');
}

function widString(w: AnyObj | string | null | undefined): string | null {
  if (!w) return null;
  if (typeof w === 'string') return w;
  if (typeof w._serialized === 'string') return w._serialized;
  if (w.user && w.server) return `${w.user}@${w.server}`;
  if (typeof w.toString === 'function') {
    const s = w.toString();
    if (s.includes('@')) return s;
  }
  return null;
}

function widUser(w: AnyObj | string | null | undefined): string | null {
  const s = widString(w);
  if (!s) return null;
  return s.split('@')[0].split(':')[0];
}

function isLidWid(w: AnyObj | string | null | undefined): boolean {
  const s = widString(w);
  return !!s && /@lid$/i.test(s);
}
function isUserWid(w: AnyObj | string | null | undefined): boolean {
  const s = widString(w);
  return !!s && /@c\.us$/i.test(s);
}

/** 缓存 lid ⇄ phone 的映射，避免重复查询 */
const pnLidCache = new Map<string, { phone: string | null; lid: string | null }>();

/**
 * 尽力把一个 chat 解析成 { phone, lid }。
 * WhatsApp 新版本会用 @lid 代替号码，这里依次尝试多条路径。
 */
async function resolveIds(chat: AnyObj): Promise<{ phone: string | null; lid: string | null }> {
  const id = chat.id;
  const key = widString(id) ?? '';
  const cached = pnLidCache.get(key);
  if (cached) return cached;

  let phone: string | null = null;
  let lid: string | null = null;

  if (isUserWid(id)) phone = widUser(id);
  else if (isLidWid(id)) lid = widUser(id);

  const contact: AnyObj | undefined = chat.contact;
  // 新版 ContactModel 上可能直接带 phoneNumber(Wid) / lid
  if (!phone && contact?.phoneNumber && isUserWid(contact.phoneNumber)) phone = widUser(contact.phoneNumber);
  if (!lid && contact?.lid && isLidWid(contact.lid)) lid = widUser(contact.lid);
  if (!phone && contact && isUserWid(contact.id)) phone = widUser(contact.id);

  // wa-js 提供的 PN/LID 互查
  if (!phone || !lid) {
    try {
      const fn = (WPP as AnyObj).contact?.getPnLidEntry;
      if (typeof fn === 'function') {
        const entry: AnyObj | null = await fn(id);
        if (entry) {
          const pn = entry.pn ?? entry.phoneNumber ?? entry.phone;
          const l = entry.lid;
          if (!phone && isUserWid(pn)) phone = widUser(pn);
          if (!lid && isLidWid(l)) lid = widUser(l);
        }
      }
    } catch (e) {
      // 对部分 wid 会抛 InvalidWidForGetPnLidEntry，忽略
    }
  }

  const r = { phone, lid };
  if (phone || lid) pnLidCache.set(key, r);
  return r;
}

function chatTitle(chat: AnyObj): string {
  return (
    chat.formattedTitle ||
    chat.contact?.formattedName ||
    chat.contact?.name ||
    chat.contact?.pushname ||
    chat.name ||
    widUser(chat.id) ||
    ''
  );
}

async function toChatInfo(chat: AnyObj): Promise<ChatInfo | null> {
  const wid = widString(chat.id);
  if (!wid) return null;
  if (!isUserWid(wid) && !isLidWid(wid)) return null; // 群、广播、频道忽略
  const { phone, lid } = await resolveIds(chat);
  if (!phone && !lid) return null;
  const contact: AnyObj | undefined = chat.contact;
  return {
    wid,
    phone,
    lid,
    pushname: contact?.pushname || contact?.name || contact?.verifiedName || null,
    title: chatTitle(chat),
    lastMsgAt: typeof chat.t === 'number' ? chat.t : null,
  };
}

async function getAccount(): Promise<AccountInfo | null> {
  let wid: string | null = null;
  try {
    const conn = (WPP as AnyObj).conn;
    const me = conn?.getMyUserWid?.() ?? conn?.getMyUserId?.();
    wid = widString(me);
  } catch {}
  if (!wid) {
    try {
      const raw = localStorage.getItem('last-wid-md') || localStorage.getItem('last-wid');
      if (raw) wid = JSON.parse(raw);
    } catch {}
  }
  if (!wid) return null;
  // 去掉设备后缀 8613800138000:12@c.us → 8613800138000@c.us
  wid = wid.replace(/:\d+@/, '@');
  const phone = /@c\.us$/.test(wid) ? wid.split('@')[0] : null;
  let pushname: string | null = null;
  try { pushname = (WPP as AnyObj).conn?.getMyPushname?.() ?? null; } catch {}
  return { wid, phone, pushname };
}

let syncing = false;
async function collectAndSend(reason: 'initial' | 'interval' | 'manual') {
  if (syncing) return;
  syncing = true;
  try {
    const account = await getAccount();
    if (account) post({ type: 'ACCOUNT', payload: account });
    const list: AnyObj[] = await (WPP as AnyObj).chat.list({ onlyUsers: true });
    const chats: ChatInfo[] = [];
    for (const c of list) {
      const info = await toChatInfo(c);
      if (info) chats.push(info);
    }
    console.log(LOG, `collected ${chats.length}/${list.length} chats (${reason})`);
    post({ type: 'CHATS', payload: { chats, reason } });
  } catch (e) {
    console.error(LOG, 'collect failed', e);
    post({ type: 'STATUS', payload: { wppReady: true, error: `读取聊天列表失败：${(e as Error).message}` } });
  } finally {
    syncing = false;
  }
}

function emitActiveChat() {
  try {
    const chat: AnyObj | null = (WPP as AnyObj).chat.getActiveChat?.();
    post({ type: 'ACTIVE_CHAT', payload: { wid: chat ? widString(chat.id) : null, title: chat ? chatTitle(chat) : null } });
  } catch {}
}

function onReady() {
  const version = (WPP as AnyObj).version ?? undefined;
  console.log(LOG, 'wa-js ready', version);
  post({ type: 'STATUS', payload: { wppReady: true, wajsVersion: version } });

  void collectAndSend('initial');
  setInterval(() => void collectAndSend('interval'), SYNC_INTERVAL_MS);

  // 新消息：只关心别人发来的、私聊的
  try {
    (WPP as AnyObj).on('chat.new_message', async (msg: AnyObj) => {
      try {
        if (msg?.id?.fromMe || msg?.fromMe) return;
        const from = msg.chatId ?? msg.from;
        if (!isUserWid(from) && !isLidWid(from)) return;
        const chat: AnyObj = await (WPP as AnyObj).chat.get(from);
        if (!chat) return;
        const info = await toChatInfo(chat);
        if (info) post({ type: 'NEW_CHAT', payload: { chat: info } });
      } catch (e) {
        console.warn(LOG, 'new_message handler failed', e);
      }
    });
  } catch (e) {
    console.warn(LOG, 'cannot subscribe chat.new_message', e);
  }

  // 当前打开的聊天变化
  try {
    (WPP as AnyObj).on('chat.active_chat', () => emitActiveChat());
  } catch {}
  setInterval(emitActiveChat, 1500); // 兜底轮询
}

// content → inject
window.addEventListener('message', (ev) => {
  const m = ev.data as ContentMessage;
  if (!m || m.source !== 'WAB_CONTENT') return;
  if (m.type === 'SYNC_REQUEST') void collectAndSend('manual');
  if (m.type === 'OPEN_CHAT') {
    try { (WPP as AnyObj).chat.openChatBottom(m.payload.wid); } catch (e) { console.warn(LOG, 'openChat failed', e); }
  }
});

post({ type: 'STATUS', payload: { wppReady: false } });

// 等 WhatsApp Web 主界面就绪（wa-js 4.x：loader.onFullReady；兜底 conn.main_ready 事件）
try {
  const W = WPP as AnyObj;
  if (W.isFullReady) onReady();
  else if (W.loader?.onFullReady) W.loader.onFullReady(onReady);
  else if (W.loader?.onReady) W.loader.onReady(onReady);
  else W.on?.('conn.main_ready', onReady);
} catch (e) {
  console.error(LOG, 'wa-js init failed', e);
  post({ type: 'STATUS', payload: { wppReady: false, error: `wa-js 初始化失败：${(e as Error).message}` } });
}
