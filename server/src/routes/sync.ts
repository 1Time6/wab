import type { FastifyInstance } from 'fastify';
import type { Store, ChatInput } from '../db.js';
import { displayPhone } from '../phone.js';
import { notifyMac } from '../notify.js';

interface SyncBody {
  account: { wid: string; phone?: string | null; alias?: string | null };
  chats: ChatInput[];
}

export function syncRoutes(app: FastifyInstance, store: Store) {
  /**
   * 扩展上报：当前账号 + 聊天列表。
   * 返回该账号视角下的全部重复客户，扩展据此在页面上打标。
   */
  app.post<{ Body: SyncBody }>('/api/sync', async (req, reply) => {
    const body = req.body;
    if (!body?.account?.wid) return reply.code(400).send({ error: 'account.wid required' });
    const chats = Array.isArray(body.chats) ? body.chats : [];

    const account = store.upsertAccount(body.account);
    const { results, newlyDuplicated } = store.syncChats(account.id, chats);
    const duplicates = store.duplicatesForAccount(account.id);

    if (newlyDuplicated.length) {
      const names = newlyDuplicated
        .slice(0, 3)
        .map((id) => {
          const c = store.getCustomer(id);
          return c ? c.display_name || displayPhone(c.phone) || `LID ${c.lid}` : '';
        })
        .filter(Boolean)
        .join('、');
      const more = newlyDuplicated.length > 3 ? ` 等 ${newlyDuplicated.length} 人` : '';
      notifyMac('WAB 发现重复客户', `${names}${more} 已在其他账号出现过（当前账号 ${account.alias || displayPhone(account.phone)}）`);
      app.log.info({ accountId: account.id, newlyDuplicated }, 'new duplicates');
    }

    return {
      account: { id: account.id, wid: account.wid, phone: account.phone, alias: account.alias },
      received: chats.length,
      upserted: results.length,
      newCustomers: results.filter((r) => r.isNewCustomer).length,
      newlyDuplicated,
      duplicates,
    };
  });
}
