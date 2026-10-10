import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, localDay } from '../src/db.ts';

function fresh() {
  return new Store(':memory:');
}

test('same phone on two accounts is a duplicate', () => {
  const s = fresh();
  const a = s.upsertAccount({ wid: '8611111111111@c.us' });
  const b = s.upsertAccount({ wid: '8622222222222@c.us', alias: '美区-2' });

  const r1 = s.syncChats(a.id, [{ phone: '8613800138000@c.us', pushname: 'Tom', lastMsgAt: 1760000000 }]);
  assert.equal(r1.newlyDuplicated.length, 0);
  assert.equal(s.duplicatesForAccount(a.id).length, 0);

  const r2 = s.syncChats(b.id, [{ phone: '+86 138 0013 8000', lastMsgAt: 1760001000 }]);
  assert.deepEqual(r2.newlyDuplicated.length, 1);

  const dupsB = s.duplicatesForAccount(b.id);
  assert.equal(dupsB.length, 1);
  assert.equal(dupsB[0].phone, '8613800138000');
  assert.equal(dupsB[0].displayName, 'Tom');
  assert.equal(dupsB[0].otherAccounts.length, 1);
  assert.equal(dupsB[0].otherAccounts[0].accountId, a.id);

  // 再同步一次不会重复报"新重复"
  const r3 = s.syncChats(b.id, [{ phone: '8613800138000' }]);
  assert.equal(r3.newlyDuplicated.length, 0);

  assert.equal(s.stats().duplicates, 1);
  assert.equal(s.stats().customers, 1);
  const list = s.listCustomers({ dup: true });
  assert.equal(list.total, 1);
  assert.equal(list.items[0].accounts.length, 2);
  s.close();
});

test('phone record and lid record get merged when mapping arrives', () => {
  const s = fresh();
  const a = s.upsertAccount({ wid: '8611111111111@c.us' });
  const b = s.upsertAccount({ wid: '8622222222222@c.us' });
  s.syncChats(a.id, [{ phone: '8613800138000' }]);
  s.syncChats(b.id, [{ lid: '99887766554433@lid', pushname: 'Jerry' }]);
  assert.equal(s.stats().customers, 2);
  assert.equal(s.stats().duplicates, 0);

  // 账号 b 后来解析出 lid 对应的号码
  const r = s.syncChats(b.id, [{ phone: '8613800138000', lid: '99887766554433' }]);
  assert.equal(s.stats().customers, 1);
  assert.equal(s.stats().duplicates, 1);
  const c = s.check('8613800138000', null)!;
  assert.equal(c.lid, '99887766554433');
  assert.equal(c.displayName, 'Jerry');
  assert.equal(c.otherAccounts.length, 2);
  // 合并后账号 b 不是"新 sighting"，所以不会再计 newlyDuplicated
  assert.equal(r.newlyDuplicated.length, 0);
  s.close();
});

test('check by lid alone and excludeAccount', () => {
  const s = fresh();
  const a = s.upsertAccount({ wid: '8611111111111@c.us' });
  s.syncChats(a.id, [{ lid: '55555555555555@lid' }]);
  const info = s.check(null, '55555555555555@lid', a.id)!;
  assert.ok(info);
  assert.equal(info.otherAccounts.length, 0);
  assert.equal(s.check('8699999999999', null), null);
  s.close();
});

test('groups and junk are ignored', () => {
  const s = fresh();
  const a = s.upsertAccount({ wid: '8611111111111@c.us' });
  const r = s.syncChats(a.id, [{ phone: '120363001234567890@g.us' }, { phone: '' }, {}]);
  assert.equal(r.results.length, 0);
  assert.equal(s.stats().customers, 0);
  s.close();
});

test('updateCustomer and listCustomers filters', () => {
  const s = fresh();
  const a = s.upsertAccount({ wid: '8611111111111@c.us' });
  s.syncChats(a.id, [{ phone: '8613800138000', pushname: 'Tom' }, { phone: '14155550123', pushname: 'Ann' }]);
  const tom = s.check('8613800138000', null)!;
  s.updateCustomer(tom.customerId, { status: 'won', note: '已成交' });
  assert.equal(s.listCustomers({ status: 'won' }).total, 1);
  assert.equal(s.listCustomers({ q: 'Ann' }).total, 1);
  assert.equal(s.listCustomers({ q: '+86 138' }).total, 1);
  assert.equal(s.listCustomers({ accountId: a.id }).total, 2);
  s.close();
});

test('dailySummary: counts new fans per account per local day, skips backfill, flags cross-account dups', () => {
  const s = fresh();
  const a = s.upsertAccount({ wid: '8611111111111@c.us' });
  const b = s.upsertAccount({ wid: '8622222222222@c.us' });
  // 两个账号都在 3 天前接入
  const now = new Date();
  const at = (daysAgo: number, hour: number) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, hour, 0, 0).getTime() / 1000;
  const joined = new Date(at(3, 9) * 1000).toISOString();
  s.db.prepare('UPDATE accounts SET created_at = ?').run(joined);
  const day = (daysAgo: number) => localDay(new Date(at(daysAgo, 12) * 1000));

  // 首次同步导入的历史聊天（最后消息早于接入时间）→ 不计
  s.syncChats(a.id, [{ phone: '8613800000001', lastMsgAt: at(10, 12) }, { phone: '8613800000002', lastMsgAt: at(3, 8) }]);
  // 2 天前：a 进 2 个新粉
  s.syncChats(a.id, [{ phone: '8613800000003', lastMsgAt: at(2, 10) }, { phone: '8613800000004', lastMsgAt: at(2, 15) }]);
  // 今天：b 进 3 个，其中 001（a 的历史客户）和 003（a 两天前的新粉）是重复
  s.syncChats(b.id, [
    { phone: '8613800000001', lastMsgAt: at(0, 0) + 60 },
    { phone: '8613800000003', lastMsgAt: at(0, 0) + 120 },
    { phone: '8613800000005', lastMsgAt: at(0, 0) + 180 },
  ]);
  // 今天：a 也进了 005，但比 b 晚 → a 这条算重复
  s.syncChats(a.id, [{ phone: '8613800000005', lastMsgAt: at(0, 0) + 240 }]);

  const r = s.dailySummary(7, now);
  assert.equal(r.days.length, 7);
  assert.equal(r.days[6], day(0));
  assert.deepEqual(r.cells[a.id][day(2)], { total: 2, dup: 0 });
  assert.deepEqual(r.cells[a.id][day(3)], { total: 0, dup: 0 });
  assert.deepEqual(r.cells[b.id][day(0)], { total: 3, dup: 2 });
  assert.deepEqual(r.cells[a.id][day(0)], { total: 1, dup: 1 });
  assert.deepEqual(r.totals[day(0)], { total: 4, dup: 3, unique: 1 });
  assert.deepEqual(r.totals[day(2)], { total: 2, dup: 0, unique: 2 });
  assert.equal(s.stats().fansToday, 4);
  assert.equal(s.stats().fansTodayDup, 3);

  // 窗口外的天不出现
  assert.equal(s.dailySummary(1, now).days.length, 1);
  assert.equal(s.dailySummary(1, now).totals[day(2)], undefined);
  s.close();
});
