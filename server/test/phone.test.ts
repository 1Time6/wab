import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, normalizeLid, parseWid } from '../src/phone.ts';

test('normalizePhone handles formats', () => {
  assert.equal(normalizePhone('+86 138 0013 8000'), '8613800138000');
  assert.equal(normalizePhone('8613800138000@c.us'), '8613800138000');
  assert.equal(normalizePhone('8613800138000:12@c.us'), '8613800138000');
  assert.equal(normalizePhone('8613800138000@s.whatsapp.net'), '8613800138000');
  assert.equal(normalizePhone('+1 (415) 555-0123'), '14155550123');
  assert.equal(normalizePhone('123456789012345@lid'), null);
  assert.equal(normalizePhone('120363001234567890@g.us'), null);
  assert.equal(normalizePhone('12'), null);
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone(null), null);
});

test('normalizeLid', () => {
  assert.equal(normalizeLid('123456789012345@lid'), '123456789012345');
  assert.equal(normalizeLid('123456789012345:3@lid'), '123456789012345');
  assert.equal(normalizeLid('8613800138000@c.us'), null);
  assert.equal(normalizeLid('123456789012345'), '123456789012345');
});

test('parseWid', () => {
  assert.deepEqual(parseWid('8613800138000@c.us'), { phone: '8613800138000', lid: null });
  assert.deepEqual(parseWid('99887766554433@lid'), { phone: null, lid: '99887766554433' });
  assert.deepEqual(parseWid('+86 138 0013 8000'), { phone: '8613800138000', lid: null });
});
