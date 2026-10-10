// 扩展内三方（inject / content / background / popup）共用的类型和常量

export const DEFAULT_SERVER = 'http://127.0.0.1:3900';
export const SYNC_INTERVAL_MS = 5 * 60 * 1000;

/** inject(MAIN world) → content 的消息 */
export type InjectMessage =
  | { source: 'WAB_INJECT'; type: 'STATUS'; payload: { wppReady: boolean; error?: string; wajsVersion?: string } }
  | { source: 'WAB_INJECT'; type: 'ACCOUNT'; payload: AccountInfo }
  | { source: 'WAB_INJECT'; type: 'CHATS'; payload: { chats: ChatInfo[]; reason: 'initial' | 'interval' | 'manual' } }
  | { source: 'WAB_INJECT'; type: 'NEW_CHAT'; payload: { chat: ChatInfo } }
  | { source: 'WAB_INJECT'; type: 'ACTIVE_CHAT'; payload: { wid: string | null; title: string | null } };

/** content → inject 的消息 */
export type ContentMessage =
  | { source: 'WAB_CONTENT'; type: 'SYNC_REQUEST' }
  | { source: 'WAB_CONTENT'; type: 'OPEN_CHAT'; payload: { wid: string } };

export interface AccountInfo {
  wid: string; // 8613800138000@c.us
  phone: string | null;
  pushname?: string | null;
}

export interface ChatInfo {
  wid: string; // id._serialized，c.us 或 lid
  phone: string | null;
  lid: string | null;
  pushname: string | null;
  title: string; // 列表里显示的标题（用来匹配 DOM 行）
  lastMsgAt: number | null; // unix 秒
}

/** 服务端 /api/sync 返回的重复项 */
export interface DuplicateInfo {
  customerId: number;
  phone: string | null;
  lid: string | null;
  displayName: string | null;
  status: string;
  note: string | null;
  firstSeen: string;
  otherAccounts: Array<{
    accountId: number;
    accountPhone: string | null;
    accountAlias: string | null;
    firstSeen: string;
    lastSeen: string;
    lastMsgAt: string | null;
    pushname: string | null;
  }>;
}

export interface SyncResponse {
  account: { id: number; wid: string; phone: string | null; alias: string | null };
  received: number;
  upserted: number;
  newCustomers: number;
  newlyDuplicated: number[];
  duplicates: DuplicateInfo[];
}

/** content → background 的请求 */
export interface ApiRequest {
  type: 'WAB_API';
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  body?: unknown;
}

/** popup → content 的请求 */
export type PopupMessage = { type: 'WAB_SYNC_NOW' } | { type: 'WAB_GET_STATE' };

/** 存在 chrome.storage.local 里、给 popup 看的状态 */
export interface ExtState {
  wppReady: boolean;
  wajsVersion?: string;
  account: AccountInfo | null;
  accountAlias?: string | null;
  lastSyncAt: string | null;
  lastSyncReason?: string;
  chatCount: number;
  dupCount: number;
  newlyDuplicated?: number;
  error: string | null;
}

export const STORAGE_SERVER_KEY = 'wab_server';
export const STORAGE_STATE_KEY = 'wab_state';

export async function getServerUrl(): Promise<string> {
  const r = await chrome.storage.local.get(STORAGE_SERVER_KEY);
  const v = (r[STORAGE_SERVER_KEY] as string | undefined)?.trim();
  return (v || DEFAULT_SERVER).replace(/\/+$/, '');
}

export function fmtPhone(phone: string | null | undefined): string {
  return phone ? `+${phone}` : '';
}

export function accountLabel(a: { accountPhone?: string | null; accountAlias?: string | null; phone?: string | null; alias?: string | null }): string {
  const alias = a.accountAlias ?? a.alias;
  const phone = a.accountPhone ?? a.phone;
  if (alias && phone) return `${alias} (${fmtPhone(phone)})`;
  return alias || fmtPhone(phone) || '未知账号';
}
