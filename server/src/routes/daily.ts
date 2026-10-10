import type { FastifyInstance } from 'fastify';
import { localDay, type Store } from '../db.js';
import { displayPhone } from '../phone.js';

export function dailyRoutes(app: FastifyInstance, store: Store) {
  app.get<{ Querystring: { days?: string } }>('/api/daily', async (req) => store.dailySummary(Number(req.query.days ?? 14)));

  /** 账号 × 日期矩阵，每天两列：进粉、其中重复；最后一行合计 */
  app.get<{ Querystring: { days?: string } }>('/api/daily.csv', async (req, reply) => {
    const { days, accounts, cells, totals } = store.dailySummary(Number(req.query.days ?? 14));
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['账号', '别名', ...days.flatMap((d) => [`${d} 进粉`, `${d} 重复`]), '合计进粉', '合计重复'];
    const lines = [header.map(esc).join(',')];
    for (const a of accounts) {
      const row = days.map((d) => cells[a.id][d]);
      lines.push(
        [
          displayPhone(a.phone) || a.wid,
          a.alias ?? '',
          ...row.flatMap((c) => [c.total, c.dup]),
          row.reduce((s, c) => s + c.total, 0),
          row.reduce((s, c) => s + c.dup, 0),
        ]
          .map(esc)
          .join(','),
      );
    }
    const t = days.map((d) => totals[d]);
    lines.push(
      ['合计', '', ...t.flatMap((c) => [c.total, c.dup]), t.reduce((s, c) => s + c.total, 0), t.reduce((s, c) => s + c.dup, 0)]
        .map(esc)
        .join(','),
    );
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="wab-daily-${localDay(new Date())}.csv"`);
    return '﻿' + lines.join('\n');
  });
}
