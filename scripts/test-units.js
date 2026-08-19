#!/usr/bin/env node
'use strict';

/**
 * Unit tests for the pure logic — the parts where a mistake costs money or
 * leaks data. No database, no network, no dependencies.
 *
 *   npm test
 *
 * The schema's own guarantees are tested separately by db/verify.sql.
 */

const assert = require('assert');

const util = require('../src/lib/util');
const events = require('../src/lib/events');
const math = require('../src/lib/commission-math');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

function group(name) {
  console.log(`\n${name}`);
}

// ---------------------------------------------------------------------------
group('Commission maths');

test('percentage of the rank deal value', () => {
  const r = math.calculate({ initial_type: 'percentage', initial_value: 10, deal_value: 1500, currency: 'USD' });
  assert.strictEqual(r.amount, 150);
  assert.strictEqual(r.basis_amount, 1500);
  assert.strictEqual(r.rate_label, '10%');
});

test('fixed amount ignores the deal value entirely', () => {
  const r = math.calculate({ initial_type: 'fixed', initial_value: 250, deal_value: 99999, currency: 'USD' });
  assert.strictEqual(r.amount, 250);
});

test('awkward percentages round to cents', () => {
  const r = math.calculate({ initial_type: 'percentage', initial_value: 33.33, deal_value: 1999.99 });
  assert.strictEqual(r.amount, 666.6);          // 666.596667 → 666.60
});

test('rounding does not lose a cent to float representation', () => {
  // Math.round(1.005 * 100) / 100 gives 1 in plain JS. round2 must give 1.01.
  assert.strictEqual(math.round2(1.005), 1.01);
  assert.strictEqual(math.round2(2.675), 2.68);
  assert.strictEqual(math.round2(0.1 + 0.2), 0.3);
});

test('recurring returns null when the rank has it switched off', () => {
  const r = math.calculate({ recurring_enabled: false, recurring_type: 'percentage', recurring_value: 5, deal_value: 1500 }, 'recurring');
  assert.strictEqual(r, null);
});

test('recurring calculates when enabled', () => {
  const r = math.calculate({ recurring_enabled: true, recurring_type: 'percentage', recurring_value: 5, deal_value: 1500, currency: 'USD' }, 'recurring');
  assert.strictEqual(r.amount, 75);
  assert.strictEqual(r.kind, 'recurring');
});

test('a missing profile yields nothing rather than zero', () => {
  assert.strictEqual(math.calculate(null), null);
});

test('a rank with no values pays nothing', () => {
  const r = math.calculate({ initial_type: 'percentage', initial_value: 0, deal_value: 0 });
  assert.strictEqual(r.amount, 0);
});

// ---------------------------------------------------------------------------
group('Recurring window');

test('an indefinite rank always accrues', () => {
  assert.strictEqual(math.withinRecurringWindow({
    startedOn: '2020-01-15', period: '2026-08-01', recurringMonths: null,
  }), true);
});

test('the starting month itself does not accrue — the initial commission covers it', () => {
  assert.strictEqual(math.withinRecurringWindow({
    startedOn: '2026-08-10', period: '2026-08-01', recurringMonths: 12,
  }), false);
});

test('the month after the start does accrue', () => {
  assert.strictEqual(math.withinRecurringWindow({
    startedOn: '2026-08-10', period: '2026-09-01', recurringMonths: 12,
  }), true);
});

test('the final month of the window still accrues', () => {
  assert.strictEqual(math.withinRecurringWindow({
    startedOn: '2026-01-05', period: '2027-01-01', recurringMonths: 12,
  }), true);
});

test('one month past the window stops', () => {
  assert.strictEqual(math.withinRecurringWindow({
    startedOn: '2026-01-05', period: '2027-02-01', recurringMonths: 12,
  }), false);
});

test('a bounded rank with no start date cannot accrue', () => {
  assert.strictEqual(math.withinRecurringWindow({
    startedOn: null, period: '2026-09-01', recurringMonths: 12,
  }), false);
});

// ---------------------------------------------------------------------------
group('Input handling');

test('slugify produces URL-safe text', () => {
  assert.strictEqual(util.slugify('Business Automation Starter!'), 'business-automation-starter');
  assert.strictEqual(util.slugify('  Café  Déjà Vu  '), 'cafe-deja-vu');
  assert.strictEqual(util.slugify('***'), '');
  assert.strictEqual(util.slugify('***', 'fallback'), 'fallback');
});

test('tokens are unguessable and stable in length', () => {
  const a = util.token(40);
  const b = util.token(40);
  assert.strictEqual(a.length, 40);
  assert.notStrictEqual(a, b);
  assert.match(a, /^[a-z0-9]+$/);
});

test('lead references are distinct', () => {
  const refs = new Set(Array.from({ length: 200 }, () => util.reference()));
  assert.strictEqual(refs.size, 200);
});

test('email validation accepts the real and rejects the broken', () => {
  assert.ok(util.isEmail('marcia.bennett@example.com'));
  assert.ok(util.isEmail('a+tag@sub.example.co.uk'));
  assert.ok(!util.isEmail('not an email'));
  assert.ok(!util.isEmail('missing@domain'));
  assert.ok(!util.isEmail(''));
});

test('escapeHtml neutralises injected markup', () => {
  assert.strictEqual(
    util.escapeHtml('<script>alert("x")</script>'),
    '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'
  );
});

test('num strips currency noise instead of returning NaN', () => {
  assert.strictEqual(util.num('$1,500.50'), 1500.50);
  assert.strictEqual(util.num('nonsense', 7), 7);
  assert.strictEqual(util.num(''), 0);
});

test('bool reads the values a checkbox actually sends', () => {
  assert.strictEqual(util.bool('1'), true);
  assert.strictEqual(util.bool('on'), true);
  assert.strictEqual(util.bool(undefined), false);
  assert.strictEqual(util.bool('0'), false);
});

test('emailList keeps valid addresses and drops the rest', () => {
  assert.deepStrictEqual(
    util.emailList('a@b.com, broken, c@d.co.uk;e@f.org'),
    ['a@b.com', 'c@d.co.uk', 'e@f.org']
  );
});

test('text truncates rather than letting a huge field through', () => {
  assert.strictEqual(util.text('x'.repeat(100), 10).length, 10);
  assert.strictEqual(util.text('   '), '');
});

// ---------------------------------------------------------------------------
group('Presentation');

test('money formats with the right currency', () => {
  assert.strictEqual(util.money(1500, 'USD'), '$1,500.00');
  assert.strictEqual(util.money(0), '$0.00');
});

test('money survives a nonsense currency code', () => {
  assert.ok(util.money(10, 'NOTREAL').includes('10'));
});

test('rateLabel reads correctly for both rate types', () => {
  assert.strictEqual(util.rateLabel('percentage', 15), '15%');
  assert.strictEqual(util.rateLabel('fixed', 250, 'USD'), '$250.00');
});

test('pagination maths holds at the edges', () => {
  const p = util.paginate(0, 1, 25);
  assert.strictEqual(p.pages, 1);
  assert.strictEqual(p.from, 0);

  const q = util.paginate(51, 3, 25);
  assert.strictEqual(q.pages, 3);
  assert.strictEqual(q.from, 51);
  assert.strictEqual(q.to, 51);
  assert.strictEqual(q.hasNext, false);

  const r = util.paginate(51, 99, 25);   // beyond the end
  assert.strictEqual(r.page, 3);
});

test('withQuery keeps filters and drops empties', () => {
  assert.strictEqual(util.withQuery({ status: 'new', q: '' }, { page: 2 }), '?status=new&page=2');
  assert.strictEqual(util.withQuery({}, {}), '');
});

test('every lead status has a label and a tone', () => {
  util.LEAD_STATUSES.forEach((s) => {
    assert.ok(s.label, `${s.value} needs a label`);
    assert.ok(s.tone, `${s.value} needs a tone`);
  });
  assert.strictEqual(util.statusMeta('closed_won').label, 'Closed / won');
  assert.strictEqual(util.statusMeta('unknown').label, 'unknown');
});

// ---------------------------------------------------------------------------
group('Notification events');

test('event keys are unique', () => {
  assert.strictEqual(new Set(events.EVENT_KEYS).size, events.EVENT_KEYS.length);
});

test('every event declares recipients that are real', () => {
  events.EVENTS.forEach((e) => {
    assert.ok(e.recipients.length, `${e.key} has no recipients`);
    e.recipients.forEach((r) => {
      assert.ok(['lead', 'agent', 'admin'].includes(r), `${e.key} has bad recipient ${r}`);
    });
  });
});

test('staff preference screen omits prospect-only events', () => {
  const keys = events.staffEvents().map((e) => e.key);
  assert.ok(!keys.includes('welcome'), 'welcome is prospect-only and must not be user-configurable');
  assert.ok(keys.includes('closed_won'));
});

test('trigger options lead with the manual-only choice', () => {
  const opts = events.triggerOptions();
  assert.strictEqual(opts[0].value, '');
  assert.strictEqual(opts.length, events.EVENTS.length + 1);
});

// ---------------------------------------------------------------------------
group('Preference resolution (admin off is a hard block)');

// Mirrors notify.isEnabled: effective = admin_enabled AND user_enabled.
const effective = (adminEnabled, userEnabled) => adminEnabled && userEnabled;

test('both on means it sends', () => assert.strictEqual(effective(true, true), true));
test('the user can mute what admin left on', () => assert.strictEqual(effective(true, false), false));
test('an admin block wins even when the user wants it', () => assert.strictEqual(effective(false, true), false));
test('both off stays off', () => assert.strictEqual(effective(false, false), false));

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
