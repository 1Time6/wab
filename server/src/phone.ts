/**
 * WhatsApp 标识归一化。
 * 输入可能是：
 *   "+86 138 0013 8000"            → phone 8613800138000
 *   "8613800138000@c.us"           → phone
 *   "8613800138000:12@c.us"        → phone（去掉 :12 设备后缀）
 *   "8613800138000@s.whatsapp.net" → phone
 *   "123456789012345@lid"          → lid 123456789012345
 */
export interface ParsedId {
  phone: string | null;
  lid: string | null;
}

export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = String(input).trim();
  // 去掉 @ 后缀
  const at = s.indexOf('@');
  if (at >= 0) {
    const server = s.slice(at + 1).toLowerCase();
    if (server === 'lid' || server === 'g.us' || server === 'broadcast' || server === 'newsletter') return null;
    s = s.slice(0, at);
  }
  // 去掉设备后缀 :12
  const colon = s.indexOf(':');
  if (colon >= 0) s = s.slice(0, colon);
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return digits;
}

export function normalizeLid(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = String(input).trim();
  const at = s.indexOf('@');
  if (at >= 0) {
    const server = s.slice(at + 1).toLowerCase();
    if (server !== 'lid') return null;
    s = s.slice(0, at);
  }
  const colon = s.indexOf(':');
  if (colon >= 0) s = s.slice(0, colon);
  const digits = s.replace(/\D/g, '');
  return digits.length >= 5 ? digits : null;
}

/** 解析一个 WID（形如 xxx@c.us / xxx@lid）或裸号码 */
export function parseWid(wid: string | null | undefined): ParsedId {
  if (!wid) return { phone: null, lid: null };
  const s = String(wid).trim();
  if (/@lid$/i.test(s)) return { phone: null, lid: normalizeLid(s) };
  return { phone: normalizePhone(s), lid: null };
}

/** 展示用：8613800138000 → +86 138…（只做简单加号前缀，不做国家格式化） */
export function displayPhone(phone: string | null): string {
  return phone ? `+${phone}` : '';
}
