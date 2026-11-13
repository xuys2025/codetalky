import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixStrings, Glyphs, MISSING } from '../src/glyphs.ts';

// A tiny device charset: ASCII letters, some Chinese, and the swap targets.
const glyphs = new Glyphs('abcdefghijklmnopqrstuvwxyz()=;.+-完成测试通过了好√×!→●□');

test('characters the device has pass through, indentation included', () => {
  assert.equal(glyphs.fix('    a = b;'), '    a = b;');
  assert.equal(glyphs.fix('完成\n测试'), '完成\n测试');
});

test('symbols are swapped for ones the device can draw', () => {
  assert.equal(glyphs.fix('✅ 测试通过'), '√ 测试通过');
  assert.equal(glyphs.fix('❌ 失败'), `× ${MISSING}${MISSING}`);
  assert.equal(glyphs.fix('⚠️ 注意'), `! ${MISSING}${MISSING}`);
  assert.equal(glyphs.fix('a ➡ b'), 'a → b');
});

test('decorative emoji are dropped with the space after them', () => {
  assert.equal(glyphs.fix('🎉 完成了'), '完成了');
  assert.equal(glyphs.fix('完成 🚀 好'), '完成 好');
  assert.equal(glyphs.fix('👍🏽'), '');
});

test('anything else shows as a box, and tabs as spaces', () => {
  assert.equal(glyphs.fix('龘'), MISSING);
  assert.equal(glyphs.fix('\ta'), '  a');
  assert.equal(glyphs.fix('a\u0007b'), 'ab');
});

test('without a charset, text is sent as is', () => {
  assert.equal(new Glyphs(null).fix('🎉 龘'), '🎉 龘');
});

test('the real charset loads and knows common Chinese', () => {
  const real = Glyphs.load();
  assert.equal(real.fix('给订单列表接口加了分页'), '给订单列表接口加了分页');
  assert.equal(real.fix('✅'), '√');
});

test('every string in a snapshot is fixed, nothing else', () => {
  const fixed = fixStrings({ a: '🎉 完成', n: 3, list: ['✅', { b: '龘' }], ok: true }, (t) => glyphs.fix(t));
  assert.deepEqual(fixed, { a: '完成', n: 3, list: ['√', { b: MISSING }], ok: true });
});
