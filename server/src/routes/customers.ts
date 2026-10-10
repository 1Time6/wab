import type { FastifyInstance } from 'fastify';
import type { Store } from '../db.js';
import { displayPhone } from '../phone.js';

const STATUSES = new Set(['new', 'following', 'won', 'lost']);

export function customerRoutes(app: FastifyInstance, store: Store) {
  app.get<{ Querystring: { dup?: string; account?: string; q?: string; status?: string; limit?: string; offset?: string } }>(
    '/api/customers',
    async (req) => {
      const q = req.query;
      return store.listCustomers({
        dup: q.dup === '1' || q.dup === 'true',
        accountId: q.account ? Number(q.account) : undefined,
        q: q.q?.trim() || undefined,
        status: q.status && STATUSES.has(q.status) ? q.status : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
        offset: q.offset ? Number(q.offset) : undefined,
      });
    },
  );

  app.patch<{ Params: { id: string }; Body: { status?: string; note?: string | null; displayName?: string | null; source?: string | null } }>(
    '/api/customers/:id',
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!store.getCustomer(id)) return reply.code(404).send({ error: 'not found' });
      const b = req.body ?? {};
      if (b.status !== undefined && !STATUSES.has(b.status)) return reply.code(400).send({ error: 'bad status' });
      return store.updateCustomer(id, b);
    },
  );

  app.get('/api/stats', async () => store.stats());

  app.get<{ Querystring: { dup?: string } }>('/api/export.csv', async (req, reply) => {
    const { items } = store.listCustomers({ dup: req.query.dup === '1', limit: 2000 });
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['号码', 'LID', '名称', '状态', '备注', '账号数', '出现的账号', '首次联系', '最后消息'];
    const lines = [header.join(',')];
    for (const c of items) {
      lines.push(
        [
          displayPhone(c.phone),
          c.lid ?? '',
          c.displayName ?? '',
          c.status,
          c.note ?? '',
          c.accountCount,
          c.accounts.map((a) => a.accountAlias || displayPhone(a.accountPhone)).join(' | '),
          c.firstSeen,
          c.lastMsgAt ?? '',
        ]
          .map(esc)
          .join(','),
      );
    }
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="wab-customers-${new Date().toISOString().slice(0, 10)}.csv"`);
    return '﻿' + lines.join('\n');
  });
}
