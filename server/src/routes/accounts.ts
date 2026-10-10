import type { FastifyInstance } from 'fastify';
import type { Store } from '../db.js';

export function accountRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/accounts', async () => store.listAccounts());

  app.patch<{ Params: { id: string }; Body: { alias?: string | null } }>('/api/accounts/:id', async (req, reply) => {
    const row = store.updateAccount(Number(req.params.id), req.body ?? {});
    if (!row) return reply.code(404).send({ error: 'not found' });
    return row;
  });
}
