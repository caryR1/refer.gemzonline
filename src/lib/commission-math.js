'use strict';

/**
 * Pure commission arithmetic — no database, no configuration, no side effects.
 *
 * Kept separate from `commissions.js` so the money maths can be unit-tested on
 * its own. If this file is wrong, people get paid the wrong amount, so it is
 * deliberately small and boring.
 */

const { rateLabel } = require('./util');

/** Round to cents without floating-point drift. */
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Work out one commission amount from a rank (commission profile).
 *
 * The rank's `deal_value` is the basis. There is no per-lead override anywhere
 * in the system — changing what a deal is worth means editing the rank.
 *
 * @param {object} profile  a commission_profiles row
 * @param {'initial'|'recurring'} kind
 * @returns {null|{kind:string, amount:number, basis_amount:number, currency:string, rate_label:string}}
 */
function calculate(profile, kind = 'initial') {
  if (!profile) return null;

  const isInitial = kind === 'initial';
  if (!isInitial && !profile.recurring_enabled) return null;

  const type = isInitial ? profile.initial_type : profile.recurring_type;
  const value = Number(isInitial ? profile.initial_value : profile.recurring_value) || 0;
  const basis = Number(profile.deal_value) || 0;
  const currency = profile.currency || 'USD';

  const amount = type === 'fixed' ? value : (basis * value) / 100;

  return {
    kind,
    amount: round2(amount),
    basis_amount: round2(basis),
    currency,
    rate_label: rateLabel(type, value, currency),
  };
}

/**
 * Whether a lead should accrue recurring commission for a given period.
 *
 * @param {object} opts
 * @param {Date|string} opts.startedOn      when the account went active
 * @param {Date|string} opts.period         first day of the period being accrued
 * @param {number|null} opts.recurringMonths null = for as long as it stays active
 */
function withinRecurringWindow({ startedOn, period, recurringMonths }) {
  if (!recurringMonths) return true;          // indefinite
  if (!startedOn) return false;

  const start = new Date(startedOn);
  const target = new Date(period);
  if (Number.isNaN(start.getTime()) || Number.isNaN(target.getTime())) return false;

  const months = (target.getUTCFullYear() - start.getUTCFullYear()) * 12
    + (target.getUTCMonth() - start.getUTCMonth());

  // Month 0 is the month the account started — the initial commission covers
  // that, so recurring runs from month 1 up to and including recurringMonths.
  return months >= 1 && months <= recurringMonths;
}

module.exports = { calculate, round2, withinRecurringWindow };
