/**
 * wa-js 的模拟实现，只用于 e2e 测试（build.mjs --mock 时通过 alias 替换 @wppconnect/wa-js）。
 * 数据来自页面设置的 window.__WAB_MOCK__，页面可通过 window.__WAB_MOCK_API__.emit 触发事件。
 * 只实现 inject.ts 用到的那几个 API，形状尽量贴近 wa-js 4.6 的类型定义。
 */
type AnyObj = Record<string, any>;

interface MockChat {
  id: string; // 8613800138000@c.us 或 123@lid
  pushname?: string;
  name?: string; // 已保存的联系人名（列表标题会显示它）
  t?: number;
  phoneNumber?: string; // lid 聊天对应的号码（模拟 getPnLidEntry 能查到）
}
interface MockData {
  account: string;
  pushname?: string;
  chats: MockChat[];
  active: string | null;
}

declare global {
  interface Window {
    __WAB_MOCK__?: MockData;
    __WAB_MOCK_API__?: { emit: (ev: string, payload?: unknown) => void; ready: () => boolean };
  }
}

function wid(s: string) {
  const [user, server] = s.split('@');
  return { user, server, _serialized: s, toString: () => s };
}

const listeners = new Map<string, Array<(p: unknown) => void>>();
export function on(ev: string, fn: (p: unknown) => void) {
  const arr = listeners.get(ev) ?? [];
  arr.push(fn);
  listeners.set(ev, arr);
}
function emit(ev: string, payload?: unknown) {
  for (const fn of listeners.get(ev) ?? []) fn(payload);
}

function data(): MockData {
  if (!window.__WAB_MOCK__) throw new Error('mock data not set');
  return window.__WAB_MOCK__;
}

export function chatModel(c: MockChat): AnyObj {
  const id = wid(c.id);
  const title = c.name || c.pushname || (id.server === 'c.us' ? '+' + id.user : 'LID ' + id.user);
  return {
    id,
    t: c.t,
    formattedTitle: title,
    name: c.name,
    contact: { id, pushname: c.pushname, name: c.name, formattedName: title },
  };
}

export const version = 'mock-4.6.1';
export let isFullReady = false;

export const loader = {
  onFullReady(cb: () => void) {
    const tick = () => {
      if (window.__WAB_MOCK__) {
        isFullReady = true;
        cb();
      } else setTimeout(tick, 50);
    };
    tick();
  },
};

export const conn = {
  getMyUserWid: () => wid(data().account),
  getMyUserId: () => wid(data().account),
  getMyPushname: () => data().pushname ?? null,
};

export const chat = {
  async list(opts: AnyObj = {}) {
    let chats = data().chats;
    if (opts.onlyUsers) chats = chats.filter((c) => /@(c\.us|lid)$/.test(c.id));
    return chats.map(chatModel);
  },
  async get(id: AnyObj | string) {
    const s = typeof id === 'string' ? id : id._serialized;
    const c = data().chats.find((c) => c.id === s);
    return c ? chatModel(c) : null;
  },
  getActiveChat() {
    const a = data().active;
    const c = a ? data().chats.find((c) => c.id === a) : undefined;
    return c ? chatModel(c) : null;
  },
  openChatBottom(id: string) {
    data().active = id;
    window.dispatchEvent(new CustomEvent('wab-mock-open', { detail: id }));
    emit('chat.active_chat', chat.getActiveChat());
  },
};

export const contact = {
  async getPnLidEntry(id: AnyObj | string) {
    const s = typeof id === 'string' ? id : id._serialized;
    const c = data().chats.find((c) => c.id === s);
    if (!c) throw new Error('InvalidWidForGetPnLidEntry');
    if (/@lid$/.test(c.id) && c.phoneNumber) {
      return { lid: wid(c.id), phoneNumber: wid(c.phoneNumber + '@c.us') };
    }
    return { phoneNumber: /@c\.us$/.test(c.id) ? wid(c.id) : undefined };
  },
};

window.__WAB_MOCK_API__ = {
  emit: (ev, payload) => {
    if (ev === 'chat.new_message') {
      const m = payload as { from: string; pushname?: string; t?: number };
      // 像真实 WhatsApp 一样，新聊天先进列表
      const d = data();
      if (!d.chats.some((c) => c.id === m.from)) d.chats.unshift({ id: m.from, pushname: m.pushname, t: m.t });
      emit('chat.new_message', { id: { fromMe: false }, from: wid(m.from), chatId: wid(m.from), t: m.t });
      return;
    }
    emit(ev, payload);
  },
  ready: () => isFullReady,
};
