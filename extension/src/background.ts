import { getServerUrl, type ApiRequest } from './shared.js';

/**
 * service worker：代替 content script 向本机服务发请求。
 * 页面（web.whatsapp.com）的 CSP 会拦 content script 的 fetch，
 * 而 service worker 使用扩展自己的 host_permissions，不受影响。
 */
chrome.runtime.onMessage.addListener((msg: ApiRequest, _sender, sendResponse) => {
  if (!msg || msg.type !== 'WAB_API') return;
  (async () => {
    const base = await getServerUrl();
    const url = base + msg.path;
    try {
      const res = await fetch(url, {
        method: msg.method,
        headers: msg.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: msg.body !== undefined ? JSON.stringify(msg.body) : undefined,
      });
      const text = await res.text();
      let data: unknown = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      sendResponse({ ok: res.ok, status: res.status, data });
    } catch (e) {
      sendResponse({ ok: false, status: 0, error: `无法连接 ${base}：${(e as Error).message}` });
    }
  })();
  return true; // 异步响应
});

// 点击扩展图标时若当前不是 WhatsApp 页面，直接打开面板（popup 也会处理，这里兜底）
chrome.runtime.onInstalled.addListener(() => {
  console.log('[WAB] extension installed');
});
