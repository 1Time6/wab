import type { FastifyInstance } from 'fastify';
import type { Store } from '../db.js';

export function checkRoutes(app: FastifyInstance, store: Store) {
  /** 单个客户即时查重。excludeAccount 为当前账号 id 或 wid，返回的 otherAccounts 不含它 */
  app.get<{ Querystring: { phone?: string; lid?: string; wid?: string; excludeAccount?: string } }>(
    '/api/check',
    async (req, reply) => {
      const { phone, lid, wid, excludeAccount } = req.query;
      let p = phone ?? null;
      let l = lid ?? null;
      if (wid) {
        if (/@lid$/i.test(wid)) l = l ?? wid;
        else p = p ?? wid;
      }
      if (!p && !l) return reply.code(400).send({ error: 'phone, lid or wid required' });

      let excludeId: number | undefined;
      if (excludeAccount) {
        if (/^\d+$/.test(excludeAccount) && !excludeAccount.includes('@')) {
          const byId = store.db.prepare('SELECT id FROM accounts WHERE id = ? OR wid = ?').get(Number(excludeAccount), excludeAccount) as { id: number } | undefined;
          excludeId = byId?.id;
        } else {
          const byWid = store.db.prepare('SELECT id FROM accounts WHERE wid = ?').get(excludeAccount) as { id: number } | undefined;
          excludeId = byWid?.id;
        }
      }
      const info = store.check(p, l, excludeId);
      return { found: !!info, duplicate: !!info && info.otherAccounts.length > 0, customer: info };
    },
  );
}
