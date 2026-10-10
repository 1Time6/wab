import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeLid, normalizePhone } from './phone.js';

export interface AccountRow {
  id: number;
  wid: string;
  phone: string | null;
  alias: string | null;
  last_sync_at: string | null;
  created_at: string;
}

export interface CustomerRow {
  id: number;
  phone: string | null;
  lid: string | null;
  display_name: string | null;
  status: string;
  note: string | null;
  source: string | null;
  created_at: string;
}

export interface SightingAccount {
  accountId: number;
  accountPhone: string | null;
  accountAlias: string | null;
  firstSeen: string;
  lastSeen: string;
  lastMsgAt: string | null;
  pushname: string | null;
}

export interface DuplicateInfo {
  customerId: number;
  phone: string | null;
  lid: string | null;
  displayName: string | null;
  status: string;
  note: string | null;
  firstSeen: string;
  otherAccounts: SightingAccount[];
}

export interface ChatInput {
  phone?: string | null;
  lid?: string | null;
  pushname?: string | null;
  lastMsgAt?: string | number | null; // ISO 或 unix 秒
}

export interface UpsertResult {
  customerId: number;
  isNewCustomer: boolean;
  isNewSighting: boolean;
  accountCount: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wid TEXT NOT NULL UNIQUE,
  phone TEXT,
  alias TEXT,
  last_sync_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE,
  lid TEXT UNIQUE,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  note TEXT,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (phone IS NOT NULL OR lid IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS sightings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_msg_at TEXT,
  pushname TEXT,
  UNIQUE(customer_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_sightings_account ON sightings(account_id);
CREATE INDEX IF NOT EXISTS idx_sightings_customer ON sightings(customer_id);
`;

/**
 * 账号首次接入后这段时间内出现的聊天算"历史导入"，不计进粉。
 * 判断依据是 sighting 的 first_seen_at（= 上报时的最后消息时间）：首次全量同步导入的老聊天，
 * 最后消息时间必然早于"接入时间 + 窗口"；之后才出现的新聊天，消息时间在窗口之后。
 */
export const BACKFILL_WINDOW_MINUTES = 10;

/** 本地时区的 YYYY-MM-DD（服务跑在运营那台电脑上，按它的时区切天） */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface DailyCell {
  total: number; // 进粉：当天新出现在该账号的客户
  dup: number; // 其中重复：之前已在别的账号出现过
}

export interface DailySummary {
  days: string[]; // 旧 → 新
  accounts: Array<{ id: number; wid: string; phone: string | null; alias: string | null }>;
  /** cells[accountId][day] */
  cells: Record<number, Record<string, DailyCell>>;
  /** 每天所有账号合计；unique = total - dup = 净新客 */
  totals: Record<string, DailyCell & { unique: number }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toIso(v: string | number | null | undefined): string | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    // WhatsApp 的 t 是 unix 秒
    const ms = v < 1e12 ? v * 1000 : v;
    return new Date(ms).toISOString();
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  // ---------- accounts ----------

  upsertAccount(input: { wid: string; phone?: string | null; alias?: string | null }): AccountRow {
    const phone = normalizePhone(input.phone) ?? normalizePhone(input.wid);
    this.db
      .prepare(
        `INSERT INTO accounts (wid, phone, alias) VALUES (?, ?, ?)
         ON CONFLICT(wid) DO UPDATE SET
           phone = COALESCE(excluded.phone, accounts.phone),
           alias = COALESCE(excluded.alias, accounts.alias)`,
      )
      .run(input.wid, phone, input.alias ?? null);
    return this.db.prepare('SELECT * FROM accounts WHERE wid = ?').get(input.wid) as unknown as AccountRow;
  }

  touchAccountSync(accountId: number) {
    this.db.prepare('UPDATE accounts SET last_sync_at = ? WHERE id = ?').run(nowIso(), accountId);
  }

  updateAccount(id: number, patch: { alias?: string | null }) {
    if (patch.alias !== undefined) {
      this.db.prepare('UPDATE accounts SET alias = ? WHERE id = ?').run(patch.alias, id);
    }
    return this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as unknown as AccountRow | undefined;
  }

  listAccounts(): Array<AccountRow & { customer_count: number; duplicate_count: number }> {
    return this.db
      .prepare(
        `SELECT a.*,
          (SELECT COUNT(*) FROM sightings s WHERE s.account_id = a.id) AS customer_count,
          (SELECT COUNT(*) FROM sightings s WHERE s.account_id = a.id
             AND (SELECT COUNT(*) FROM sightings s2 WHERE s2.customer_id = s.customer_id) > 1) AS duplicate_count
         FROM accounts a ORDER BY a.id`,
      )
      .all() as unknown as Array<AccountRow & { customer_count: number; duplicate_count: number }>;
  }

  // ---------- customers / sightings ----------

  private getCustomerByPhone(phone: string): CustomerRow | undefined {
    return this.db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone) as unknown as CustomerRow | undefined;
  }
  private getCustomerByLid(lid: string): CustomerRow | undefined {
    return this.db.prepare('SELECT * FROM customers WHERE lid = ?').get(lid) as unknown as CustomerRow | undefined;
  }

  getCustomer(id: number): CustomerRow | undefined {
    return this.db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as unknown as CustomerRow | undefined;
  }

  /** 把 loser 合并进 winner（sightings 迁移、缺失字段补齐），删除 loser */
  private mergeCustomers(winner: CustomerRow, loser: CustomerRow): CustomerRow {
    const loserSightings = this.db
      .prepare('SELECT * FROM sightings WHERE customer_id = ?')
      .all(loser.id) as unknown as Array<{
      id: number; account_id: number; first_seen_at: string; last_seen_at: string; last_msg_at: string | null; pushname: string | null;
    }>;
    for (const s of loserSightings) {
      const existing = this.db
        .prepare('SELECT id, first_seen_at, last_seen_at, last_msg_at FROM sightings WHERE customer_id = ? AND account_id = ?')
        .get(winner.id, s.account_id) as unknown as { id: number; first_seen_at: string; last_seen_at: string; last_msg_at: string | null } | undefined;
      if (existing) {
        this.db
          .prepare(
            `UPDATE sightings SET
               first_seen_at = MIN(first_seen_at, ?),
               last_seen_at = MAX(last_seen_at, ?),
               last_msg_at = MAX(COALESCE(last_msg_at, ''), COALESCE(?, '')),
               pushname = COALESCE(pushname, ?)
             WHERE id = ?`,
          )
          .run(s.first_seen_at, s.last_seen_at, s.last_msg_at, s.pushname, existing.id);
        this.db.prepare('DELETE FROM sightings WHERE id = ?').run(s.id);
      } else {
        this.db.prepare('UPDATE sightings SET customer_id = ? WHERE id = ?').run(winner.id, s.id);
      }
    }
    // 先删 loser 释放 UNIQUE(lid/phone)，再把它的键补到 winner
    this.db.prepare('DELETE FROM customers WHERE id = ?').run(loser.id);
    this.db
      .prepare(
        `UPDATE customers SET
           phone = COALESCE(phone, ?),
           lid = COALESCE(lid, ?),
           display_name = COALESCE(display_name, ?),
           note = CASE WHEN note IS NULL OR note = '' THEN ? ELSE note END,
           status = CASE WHEN status = 'new' AND ? <> 'new' THEN ? ELSE status END
         WHERE id = ?`,
      )
      .run(loser.phone, loser.lid, loser.display_name, loser.note, loser.status, loser.status, winner.id);
    return this.getCustomer(winner.id)!;
  }

  /**
   * 单条 chat 的 upsert：找到/创建客户，记录该账号的 sighting。
   * 调用方应放在事务里。
   */
  upsertSighting(accountId: number, chat: ChatInput): UpsertResult | null {
    const phone = normalizePhone(chat.phone);
    const lid = normalizeLid(chat.lid);
    if (!phone && !lid) return null;

    const byPhone = phone ? this.getCustomerByPhone(phone) : undefined;
    const byLid = lid ? this.getCustomerByLid(lid) : undefined;

    let customer: CustomerRow | undefined;
    let isNewCustomer = false;

    if (byPhone && byLid && byPhone.id !== byLid.id) {
      // 两条记录其实是同一个人（号码记录 + LID 记录），合并，以号码记录为主
      customer = this.mergeCustomers(byPhone, byLid);
    } else {
      customer = byPhone ?? byLid;
    }

    const pushname = chat.pushname?.trim() || null;
    if (!customer) {
      const r = this.db
        .prepare('INSERT INTO customers (phone, lid, display_name) VALUES (?, ?, ?)')
        .run(phone, lid, pushname);
      customer = this.getCustomer(Number(r.lastInsertRowid))!;
      isNewCustomer = true;
    } else {
      this.db
        .prepare(
          `UPDATE customers SET
             phone = COALESCE(phone, ?),
             lid = COALESCE(lid, ?),
             display_name = COALESCE(display_name, ?)
           WHERE id = ?`,
        )
        .run(phone, lid, pushname, customer.id);
    }

    const now = nowIso();
    const lastMsgAt = toIso(chat.lastMsgAt);
    const existing = this.db
      .prepare('SELECT id FROM sightings WHERE customer_id = ? AND account_id = ?')
      .get(customer.id, accountId) as unknown as { id: number } | undefined;
    let isNewSighting = false;
    if (existing) {
      this.db
        .prepare(
          `UPDATE sightings SET
             last_seen_at = ?,
             last_msg_at = CASE WHEN ? IS NULL THEN last_msg_at
                                WHEN last_msg_at IS NULL THEN ?
                                ELSE MAX(last_msg_at, ?) END,
             pushname = COALESCE(?, pushname)
           WHERE id = ?`,
        )
        .run(now, lastMsgAt, lastMsgAt, lastMsgAt, pushname, existing.id);
    } else {
      this.db
        .prepare(
          `INSERT INTO sightings (customer_id, account_id, first_seen_at, last_seen_at, last_msg_at, pushname)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(customer.id, accountId, lastMsgAt ?? now, now, lastMsgAt, pushname);
      isNewSighting = true;
    }

    const { c } = this.db
      .prepare('SELECT COUNT(*) AS c FROM sightings WHERE customer_id = ?')
      .get(customer.id) as unknown as { c: number };

    return { customerId: customer.id, isNewCustomer, isNewSighting, accountCount: c };
  }

  /** 批量同步（事务） */
  syncChats(accountId: number, chats: ChatInput[]): { results: UpsertResult[]; newlyDuplicated: number[] } {
    const results: UpsertResult[] = [];
    const newlyDuplicated: number[] = [];
    this.db.exec('BEGIN');
    try {
      for (const chat of chats) {
        const r = this.upsertSighting(accountId, chat);
        if (!r) continue;
        results.push(r);
        // 刚因为本次上报变成"出现在 2 个账号"的客户 → 新发现的重复
        if (r.isNewSighting && r.accountCount === 2) newlyDuplicated.push(r.customerId);
      }
      this.touchAccountSync(accountId);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { results, newlyDuplicated };
  }

  private sightingAccounts(customerId: number, excludeAccountId?: number): SightingAccount[] {
    const rows = this.db
      .prepare(
        `SELECT a.id AS accountId, a.phone AS accountPhone, a.alias AS accountAlias,
                s.first_seen_at AS firstSeen, s.last_seen_at AS lastSeen, s.last_msg_at AS lastMsgAt, s.pushname
         FROM sightings s JOIN accounts a ON a.id = s.account_id
         WHERE s.customer_id = ? AND (? IS NULL OR s.account_id <> ?)
         ORDER BY s.first_seen_at`,
      )
      .all(customerId, excludeAccountId ?? null, excludeAccountId ?? null) as unknown as SightingAccount[];
    return rows;
  }

  private toDuplicateInfo(c: CustomerRow, excludeAccountId?: number): DuplicateInfo {
    const all = this.sightingAccounts(c.id);
    const firstSeen = all.reduce((m, s) => (s.firstSeen < m ? s.firstSeen : m), all[0]?.firstSeen ?? c.created_at);
    return {
      customerId: c.id,
      phone: c.phone,
      lid: c.lid,
      displayName: c.display_name,
      status: c.status,
      note: c.note,
      firstSeen,
      otherAccounts: excludeAccountId == null ? all : all.filter((s) => s.accountId !== excludeAccountId),
    };
  }

  /** 某账号视角下的重复客户：该账号有、且其他账号也有 */
  duplicatesForAccount(accountId: number): DuplicateInfo[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM sightings s JOIN customers c ON c.id = s.customer_id
         WHERE s.account_id = ?
           AND (SELECT COUNT(*) FROM sightings s2 WHERE s2.customer_id = c.id) > 1`,
      )
      .all(accountId) as unknown as CustomerRow[];
    return rows.map((c) => this.toDuplicateInfo(c, accountId));
  }

  /** 查单个客户（phone 或 lid 任一命中） */
  check(phone: string | null | undefined, lid: string | null | undefined, excludeAccountId?: number): DuplicateInfo | null {
    const p = normalizePhone(phone);
    const l = normalizeLid(lid);
    const c = (p && this.getCustomerByPhone(p)) || (l && this.getCustomerByLid(l)) || undefined;
    if (!c) return null;
    return this.toDuplicateInfo(c, excludeAccountId);
  }

  listCustomers(opts: {
    dup?: boolean;
    accountId?: number;
    q?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }) {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts.dup) where.push('account_count > 1');
    if (opts.accountId) {
      where.push('EXISTS (SELECT 1 FROM sightings sx WHERE sx.customer_id = x.id AND sx.account_id = ?)');
      params.push(opts.accountId);
    }
    if (opts.q) {
      const like = `%${opts.q.replace(/\D/g, '') || opts.q}%`;
      where.push('(phone LIKE ? OR lid LIKE ? OR display_name LIKE ?)');
      params.push(like, like, `%${opts.q}%`);
    }
    if (opts.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
    const offset = Math.max(opts.offset ?? 0, 0);
    const sql = `
      SELECT * FROM (
        SELECT c.*,
          (SELECT COUNT(*) FROM sightings s WHERE s.customer_id = c.id) AS account_count,
          (SELECT MIN(first_seen_at) FROM sightings s WHERE s.customer_id = c.id) AS first_seen_at,
          (SELECT MAX(last_msg_at) FROM sightings s WHERE s.customer_id = c.id) AS last_msg_at,
          (SELECT json_group_array(json_object(
              'accountId', a.id, 'accountPhone', a.phone, 'accountAlias', a.alias,
              'firstSeen', s.first_seen_at, 'lastMsgAt', s.last_msg_at, 'pushname', s.pushname))
           FROM sightings s JOIN accounts a ON a.id = s.account_id WHERE s.customer_id = c.id) AS accounts_json
        FROM customers c
      ) x
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY COALESCE(last_msg_at, first_seen_at) DESC
      LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...params, limit, offset) as unknown as Array<
      CustomerRow & { account_count: number; first_seen_at: string; last_msg_at: string | null; accounts_json: string }
    >;
    const countSql = `SELECT COUNT(*) AS c FROM (
        SELECT c.id, c.phone, c.lid, c.display_name, c.status,
          (SELECT COUNT(*) FROM sightings s WHERE s.customer_id = c.id) AS account_count
        FROM customers c) x ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
    const { c: total } = this.db.prepare(countSql).get(...params) as unknown as { c: number };
    return {
      total,
      items: rows.map((r) => ({
        id: r.id,
        phone: r.phone,
        lid: r.lid,
        displayName: r.display_name,
        status: r.status,
        note: r.note,
        source: r.source,
        createdAt: r.created_at,
        accountCount: r.account_count,
        firstSeen: r.first_seen_at,
        lastMsgAt: r.last_msg_at,
        accounts: JSON.parse(r.accounts_json) as SightingAccount[],
      })),
    };
  }

  updateCustomer(id: number, patch: { status?: string; note?: string | null; displayName?: string | null; source?: string | null }) {
    const sets: string[] = [];
    const params: Array<string | null | number> = [];
    if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
    if (patch.note !== undefined) { sets.push('note = ?'); params.push(patch.note); }
    if (patch.displayName !== undefined) { sets.push('display_name = ?'); params.push(patch.displayName); }
    if (patch.source !== undefined) { sets.push('source = ?'); params.push(patch.source); }
    if (sets.length) {
      params.push(id);
      this.db.prepare(`UPDATE customers SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    }
    return this.getCustomer(id);
  }

  stats() {
    const row = this.db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM accounts) AS accounts,
          (SELECT COUNT(*) FROM customers) AS customers,
          (SELECT COUNT(*) FROM (SELECT customer_id FROM sightings GROUP BY customer_id HAVING COUNT(*) > 1)) AS duplicates`,
      )
      .get() as unknown as { accounts: number; customers: number; duplicates: number };
    const today = this.dailySummary(1).totals[localDay(new Date())];
    return { ...row, fansToday: today.total, fansTodayDup: today.dup };
  }

  /**
   * 每日进粉汇总：最近 `days` 天（含今天，按本地时区切天），每个账号每天新进的客户数及其中的重复数。
   * 首次接入时导入的历史聊天不计（见 BACKFILL_WINDOW_MINUTES）。
   * "重复" = 同一客户在别的账号更早出现过（同一时刻按记录先后），所以 total - dup 就是当天的净新客。
   */
  dailySummary(days: number, now: Date = new Date()): DailySummary {
    const n = Math.min(Math.max(Math.floor(days) || 1, 1), 366);
    const dayList: string[] = [];
    for (let i = n - 1; i >= 0; i--) {
      dayList.push(localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
    }
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (n - 1)).toISOString();
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

    const rows = this.db
      .prepare(
        `SELECT s.account_id AS accountId, s.first_seen_at AS firstSeen,
           EXISTS (SELECT 1 FROM sightings s2
                   WHERE s2.customer_id = s.customer_id AND s2.account_id <> s.account_id
                     AND (s2.first_seen_at < s.first_seen_at OR (s2.first_seen_at = s.first_seen_at AND s2.id < s.id))
           ) AS isDup
         FROM sightings s JOIN accounts a ON a.id = s.account_id
         WHERE s.first_seen_at >= ? AND s.first_seen_at < ?
           AND s.first_seen_at > strftime('%Y-%m-%dT%H:%M:%fZ', a.created_at, '+${BACKFILL_WINDOW_MINUTES} minutes')`,
      )
      .all(from, to) as unknown as Array<{ accountId: number; firstSeen: string; isDup: number }>;

    const accounts = this.db
      .prepare('SELECT id, wid, phone, alias FROM accounts ORDER BY id')
      .all() as unknown as DailySummary['accounts'];
    const cells: DailySummary['cells'] = {};
    const totals: DailySummary['totals'] = {};
    for (const d of dayList) totals[d] = { total: 0, dup: 0, unique: 0 };
    for (const a of accounts) {
      cells[a.id] = {};
      for (const d of dayList) cells[a.id][d] = { total: 0, dup: 0 };
    }
    for (const r of rows) {
      const d = localDay(new Date(r.firstSeen));
      const cell = cells[r.accountId]?.[d];
      if (!cell) continue;
      cell.total++;
      totals[d].total++;
      if (r.isDup) {
        cell.dup++;
        totals[d].dup++;
      } else {
        totals[d].unique++;
      }
    }
    return { days: dayList, accounts, cells, totals };
  }
}
