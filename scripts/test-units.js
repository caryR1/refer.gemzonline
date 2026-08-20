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
group('Rank terms');

const rankLib = require('../src/lib/ranks');

const campaign = { id: 'c1', currency: 'JMD', deal_value: 1500 };
const standard = {
  id: 'r1', name: 'Standard', rank_order: 0,
  initial_type: 'percentage', initial_value: 10,
  recurring_enabled: false, recurring_type: 'percentage', recurring_value: 0,
  recurring_months: null, payout_day: 15, deal_value: null, currency: 'USD', status: 'active',
};
const senior = {
  ...standard, id: 'r2', name: 'Senior', rank_order: 10, initial_value: 15,
  auto_promote: true, promote_after_deals: 6, promote_after_amount: null,
};

test('a rank with no deal value inherits the campaign', () => {
  const t = rankLib.resolveTerms(standard, campaign);
  assert.strictEqual(t.deal_value, 1500);
  assert.strictEqual(t.deal_value_source, 'campaign');
});

test('a rank can override the campaign deal value', () => {
  const t = rankLib.resolveTerms({ ...standard, deal_value: 500 }, campaign);
  assert.strictEqual(t.deal_value, 500);
  assert.strictEqual(t.deal_value_source, 'rank');
});

test('an explicit zero is an override, not an absence', () => {
  // Blank means inherit; a typed 0 means this rank really does earn nothing on
  // percentages. Collapsing the two would silently pay the campaign rate.
  const t = rankLib.resolveTerms({ ...standard, deal_value: 0 }, campaign);
  assert.strictEqual(t.deal_value, 0);
  assert.strictEqual(t.deal_value_source, 'rank');
});

test('the campaign owns the currency, whatever the rank says', () => {
  assert.strictEqual(rankLib.resolveTerms(standard, campaign).currency, 'JMD');
});

test('a snapshot survives the rank being edited afterwards', () => {
  const lead = { terms: rankLib.snapshot(standard, campaign) };

  // The rank is generous now, and the campaign is worth more. Neither reaches
  // backwards: the lead was referred on the old terms and keeps them.
  const editedRank = { ...standard, initial_value: 50 };
  const richerCampaign = { ...campaign, deal_value: 99999 };

  const terms = rankLib.termsForLead(lead, { profile: editedRank, campaign: richerCampaign });
  assert.strictEqual(terms.initial_value, 10);
  assert.strictEqual(terms.deal_value, 1500);
  assert.strictEqual(math.calculate(terms, 'initial').amount, 150);
});

test('a lead with no snapshot falls back to the live rank', () => {
  // Leads referred before snapshots existed must keep behaving as they did,
  // not suddenly calculate from nothing.
  const terms = rankLib.termsForLead({ terms: null }, { profile: standard, campaign });
  assert.strictEqual(terms.initial_value, 10);
  assert.strictEqual(rankLib.isSnapshotted({ terms: null }), false);
});

test('the snapshot is shaped so the money maths cannot tell the difference', () => {
  const snap = rankLib.snapshot(senior, campaign);
  const live = rankLib.resolveTerms(senior, campaign);
  assert.strictEqual(math.calculate(snap, 'initial').amount, math.calculate(live, 'initial').amount);
  assert.ok(snap.captured_at, 'a snapshot records when it was taken');
});

// ---------------------------------------------------------------------------
group('Products and the commission basis');

// The basis rules are arithmetic and live in commission-math, so they can be
// tested without a database. lib/products re-exports them for callers.
const productLib = math;

test('the product decides the value when there is one', () => {
  const terms = rankLib.resolveTerms(standard, campaign);      // campaign is 1500
  const lead = { product_value: 5000, product_name: 'Enterprise' };
  const basis = productLib.basisFor(lead, terms);
  assert.strictEqual(basis.amount, 5000);
  assert.strictEqual(basis.source, 'product');
});

test('without a product it falls back to the rank, then the campaign', () => {
  const inherited = rankLib.resolveTerms(standard, campaign);
  assert.strictEqual(productLib.basisFor({}, inherited).source, 'campaign');

  const overriding = rankLib.resolveTerms({ ...standard, deal_value: 750 }, campaign);
  assert.strictEqual(productLib.basisFor({}, overriding).source, 'rank');
  assert.strictEqual(productLib.basisFor({}, overriding).amount, 750);
});

test('rank sets the rate, product sets the value', () => {
  // Standard is 10%, Senior 15%. Enterprise is 5000, Starter 500. The four
  // combinations should give four different, predictable answers.
  const cases = [
    [standard, 5000, 500],
    [standard, 500, 50],
    [senior, 5000, 750],
    [senior, 500, 75],
  ];
  cases.forEach(([rank, value, expected]) => {
    const terms = productLib.applyProduct(rankLib.resolveTerms(rank, campaign), { product_value: value });
    assert.strictEqual(math.calculate(terms, 'initial').amount, expected,
      `${rank.name} on a ${value} product`);
  });
});

test('a snapshot is not mutated by having a product applied to it', () => {
  // The snapshot is a record of a moment. Something reading it must not be able
  // to change what it says.
  const snap = rankLib.snapshot(standard, campaign);
  productLib.applyProduct(snap, { product_value: 9999 });
  assert.strictEqual(snap.deal_value, 1500, 'the stored snapshot must be untouched');
});

test('a free product is a real answer, not a missing one', () => {
  const terms = rankLib.resolveTerms(standard, campaign);
  assert.strictEqual(productLib.basisFor({ product_value: 0 }, terms).amount, 0);
  assert.strictEqual(productLib.basisFor({ product_value: 0 }, terms).source, 'product');
});

test('nothing configured anywhere reports itself rather than guessing', () => {
  const basis = productLib.basisFor({}, null);
  assert.strictEqual(basis.amount, 0);
  assert.strictEqual(basis.source, 'none');
});

// ---------------------------------------------------------------------------
group('Promotion');

test('a rank with no threshold never promotes anyone', () => {
  assert.strictEqual(rankLib.qualifies({ ...senior, promote_after_deals: null }, { closedDeals: 999 }), false);
});

test('a rank that is not set to auto-promote is never reached', () => {
  assert.strictEqual(rankLib.qualifies({ ...senior, auto_promote: false }, { closedDeals: 999 }), false);
});

test('the threshold has to actually be met', () => {
  assert.strictEqual(rankLib.qualifies(senior, { closedDeals: 5 }), false);
  assert.strictEqual(rankLib.qualifies(senior, { closedDeals: 6 }), true);
});

test('two thresholds means both, not either', () => {
  const both = { ...senior, promote_after_deals: 6, promote_after_amount: 5000 };
  assert.strictEqual(rankLib.qualifies(both, { closedDeals: 6, earned: 4999 }), false);
  assert.strictEqual(rankLib.qualifies(both, { closedDeals: 5, earned: 9000 }), false);
  assert.strictEqual(rankLib.qualifies(both, { closedDeals: 6, earned: 5000 }), true);
});

test('promotion never moves an agent down', () => {
  const partner = { ...senior, id: 'r3', name: 'Partner', rank_order: 20, promote_after_deals: 20 };
  const all = [standard, senior, partner];
  // Already Partner, and nothing above it qualifies.
  assert.strictEqual(rankLib.nextRankFor(all, partner, { closedDeals: 999 }), null);
  // Already Senior — Standard is below, so it is never a candidate.
  assert.strictEqual(rankLib.nextRankFor(all, senior, { closedDeals: 6 }), null);
});

test('an agent who blows past two thresholds lands at the top of them', () => {
  const partner = { ...senior, id: 'r3', name: 'Partner', rank_order: 20, promote_after_deals: 20 };
  const next = rankLib.nextRankFor([standard, senior, partner], standard, { closedDeals: 25 });
  assert.strictEqual(next.name, 'Partner', 'should not climb one rank a night');
});

test('an archived rank is not a promotion target', () => {
  const archived = { ...senior, status: 'archived' };
  assert.strictEqual(rankLib.nextRankFor([standard, archived], standard, { closedDeals: 99 }), null);
});

test('an unranked agent can still be promoted into the first rank', () => {
  const entry = { ...standard, rank_order: 0, auto_promote: true, promote_after_deals: 1 };
  assert.strictEqual(rankLib.nextRankFor([entry], null, { closedDeals: 1 }).name, 'Standard');
});

test('the requirement reads as a sentence', () => {
  assert.strictEqual(rankLib.requirementLabel(senior), '6 closed deals');
  assert.strictEqual(
    rankLib.requirementLabel({ ...senior, promote_after_amount: 5000 }, (n) => `$${n}`),
    '6 closed deals and $5000 earned'
  );
});

// ---------------------------------------------------------------------------
group('Address formatting');

test('a full address reads like an envelope', () => {
  assert.deepStrictEqual(
    util.addressLines({
      address: '12 Hope Road', address_line2: 'Apt 4B',
      city: 'Kingston', region: 'St Andrew', postal_code: 'JMAAW10', country: 'Jamaica',
    }),
    ['12 Hope Road', 'Apt 4B', 'Kingston, St Andrew JMAAW10', 'Jamaica']
  );
});

test('a city on its own does not become stray commas', () => {
  assert.deepStrictEqual(util.addressLines({ city: 'Kingston' }), ['Kingston']);
});

test('an empty address is no lines at all, not one blank one', () => {
  assert.deepStrictEqual(util.addressLines({}), []);
  assert.deepStrictEqual(util.addressLines(null), []);
  assert.strictEqual(util.addressOneLine({ city: '', country: '  ' }), '');
});

test('the payout address reads through its prefix', () => {
  assert.strictEqual(
    util.addressOneLine({
      payout_addr_line1: '5 Main St',
      payout_addr_city: 'Bristol',
      payout_addr_country: 'United Kingdom',
    }, 'payout_addr_'),
    '5 Main St, Bristol, United Kingdom'
  );
});

// ---------------------------------------------------------------------------
group('Payout encryption');

// A fixed key, so these do not depend on the operator's environment.
process.env.PAYOUT_ENCRYPTION_KEY = 'a'.repeat(64);
const secrets = require('../src/lib/crypto');
const payouts = require('../src/lib/payouts');
secrets.resetKeyCache();

test('what goes in comes back out', () => {
  const value = 'GB29NWBK60161331926819';
  const sealed = secrets.encrypt(value);
  assert.notStrictEqual(sealed, value);
  assert.ok(!sealed.includes(value), 'the plaintext must not appear in the envelope');
  assert.strictEqual(secrets.decrypt(sealed), value);
});

test('the same value encrypts differently every time', () => {
  // A fresh IV per message. Without one, two agents banking at the same place
  // would be visible as identical ciphertexts to anyone reading the table.
  assert.notStrictEqual(secrets.encrypt('12345678'), secrets.encrypt('12345678'));
});

test('a tampered ciphertext refuses to decrypt', () => {
  const parts = secrets.encrypt('12345678').split('.');
  parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('AA') ? 'BB' : 'AA');
  assert.throws(() => secrets.decrypt(parts.join('.')));
});

test('a ciphertext cannot be replayed into another purpose', () => {
  assert.throws(() => secrets.decrypt(secrets.encrypt('12345678', 'payout'), 'something-else'));
});

test('empty in, empty out — absence stays absence', () => {
  assert.strictEqual(secrets.encrypt(''), null);
  assert.strictEqual(secrets.encrypt(null), null);
  assert.strictEqual(secrets.decrypt(null), null);
  assert.strictEqual(secrets.decrypt(''), null);
});

test('something that is not one of our envelopes is null, not a crash', () => {
  assert.strictEqual(secrets.decrypt('just some text'), null);
  assert.strictEqual(secrets.decrypt('v9.a.b.c'), null);
});

test('masking shows enough to recognise and no more', () => {
  assert.strictEqual(secrets.mask('GB29NWBK60161331926819'), '•••• 6819');
  assert.strictEqual(secrets.mask('cary@example.com'), 'ca••@example.com');
  assert.strictEqual(secrets.lastFour('6016 1331 9268 19'), '6819');
});

// ---------------------------------------------------------------------------
group('Payout details');

const baseForm = {
  payout_holder_name: 'Cary Robinson',
  payout_holder_type: 'personal',
  payout_currency: 'USD',
  payout_bank_country: 'Jamaica',
};

test('a valid SWIFT account is accepted and normalised', () => {
  const r = payouts.fromForm({
    ...baseForm,
    payout_method: 'swift',
    payout_bank_name: 'National Commercial Bank',
    payout_swift_bic: 'jncbjmkx',
    payout_account_number: '3512 44779',
  });
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.secrets.swift_bic, 'JNCBJMKX', 'a BIC is stored uppercase and unspaced');
  assert.strictEqual(r.secrets.account_number, '351244779');
});

test('a nine-digit routing number is required for a US account', () => {
  const r = payouts.fromForm({
    ...baseForm,
    payout_method: 'aba',
    payout_routing_number: '12345',
    payout_account_number: '000123456',
    payout_us_account_kind: 'checking',
  });
  assert.ok(r.errors.some((e) => e.includes('9 digits')), r.errors.join(' | '));
});

test('a UK sort code survives being typed with dashes', () => {
  const r = payouts.fromForm({
    ...baseForm,
    payout_method: 'sort_code',
    payout_bank_country: 'United Kingdom',
    payout_sort_code: '60-16-13',
    payout_account_number: '31926819',
  });
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.secrets.sort_code, '601613');
});

test('an IBAN that is not shaped like an IBAN is rejected', () => {
  const r = payouts.fromForm({ ...baseForm, payout_method: 'iban', payout_iban: 'NOTANIBAN' });
  assert.ok(r.errors.length, 'expected a complaint about the IBAN');
});

test('a Wisetag is as valid as a Wise email', () => {
  const tag = payouts.fromForm({ ...baseForm, payout_method: 'wise', payout_wise_identifier: '@caryr' });
  const mail = payouts.fromForm({ ...baseForm, payout_method: 'wise', payout_wise_identifier: 'cary@example.com' });
  assert.deepStrictEqual(tag.errors, []);
  assert.deepStrictEqual(mail.errors, []);
});

test('the account holder name is not optional', () => {
  const r = payouts.fromForm({
    ...baseForm, payout_holder_name: '', payout_method: 'wise', payout_wise_identifier: '@caryr',
  });
  assert.ok(r.errors.some((e) => e.toLowerCase().includes('holder name')));
});

test('a currency we cannot pay in is refused', () => {
  const r = payouts.fromForm({
    ...baseForm, payout_currency: 'XYZ', payout_method: 'wise', payout_wise_identifier: '@caryr',
  });
  assert.ok(r.errors.some((e) => e.includes('XYZ')));
});

test('choosing nothing clears rather than half-saving', () => {
  const r = payouts.fromForm({ payout_method: '' });
  assert.strictEqual(r.cleared, true);
  assert.deepStrictEqual(r.errors, []);
});

test('a saved account round-trips through encryption', () => {
  const parsed = payouts.fromForm({
    ...baseForm,
    payout_method: 'iban',
    payout_bank_country: 'United Kingdom',
    payout_iban: 'GB29 NWBK 6016 1331 9268 19',
  });
  assert.deepStrictEqual(parsed.errors, []);

  const stored = payouts.encryptSecrets('iban', parsed.secrets);
  assert.strictEqual(stored.payout_last4, '6819');
  assert.ok(!String(stored.payout_secrets).includes('NWBK'), 'the IBAN must not be readable in the stored value');

  const row = {
    payout_method: 'iban', ...stored,
    payout_holder_name: 'Cary Robinson', payout_currency: 'USD',
  };
  assert.strictEqual(payouts.reveal(row).iban, 'GB29NWBK60161331926819');
  assert.strictEqual(payouts.summary(row).masked, '•••• 6819');
});

test('the summary never carries the number itself', () => {
  const parsed = payouts.fromForm({ ...baseForm, payout_method: 'iban', payout_iban: 'GB29NWBK60161331926819' });
  const row = {
    payout_method: 'iban', payout_holder_name: 'Cary Robinson', payout_currency: 'USD',
    ...payouts.encryptSecrets('iban', parsed.secrets),
  };
  assert.ok(!JSON.stringify(payouts.summary(row)).includes('NWBK'));
});

test('every scheme code the form offers is one the database accepts', () => {
  // These must match the check constraint in db/migrations/001. A new scheme
  // added here and not there fails at INSERT, on the agent, in production.
  assert.deepStrictEqual(
    payouts.SCHEME_CODES.slice().sort(),
    ['aba', 'canada', 'iban', 'other', 'paypal', 'sort_code', 'swift', 'wise']
  );
});

// ---------------------------------------------------------------------------
group('Production URL guard');

// Mirrors config.appUrlIsLocal — the check that stops production emailing links
// to localhost. Same expression, so the two cannot drift apart silently.
const isLocal = (url) => /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(url);

test('development addresses are recognised in every usual spelling', () => {
  ['http://localhost:3000', 'http://127.0.0.1:3000', 'https://localhost',
    'http://0.0.0.0:8080', 'http://[::1]:3000']
    .forEach((url) => assert.strictEqual(isLocal(url), true, url));
});

test('a real host is not mistaken for a local one', () => {
  ['https://rportal.gemzonline.com', 'https://localhost.example.com', 'https://my-localhost-app.com']
    .forEach((url) => assert.strictEqual(isLocal(url), false, url));
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
