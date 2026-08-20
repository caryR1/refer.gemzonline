'use strict';

/**
 * Ranks — resolving what an agent earns, and when they move up.
 *
 * Three rules, decided deliberately rather than by accident of implementation:
 *
 *   1. THE RANK AT REFERRAL PAYS. A lead is stamped with the agent's rank, and
 *      a snapshot of that rank's terms, the moment it arrives. Whatever happens
 *      to the agent or the rank afterwards, the lead pays what it was worth
 *      when the work was done.
 *
 *   2. EDITING A RANK AFFECTS NEW WORK ONLY. This falls out of rule 1 rather
 *      than needing enforcement: the terms are already on the lead, so there is
 *      nothing for an edit to reach back into.
 *
 *   3. PROMOTION ONLY GOES UP. A rank declares what earns it; an agent who
 *      meets every threshold is moved to the highest rank they qualify for.
 *      Nothing here ever demotes anyone — that stays a human decision.
 *
 * Seniority is `rank_order`: higher is more senior.
 */

const { calculate } = require('./commission-math');

/**
 * The terms an agent on this rank actually earns under.
 *
 * A rank may override the campaign's deal value; null means inherit. Currency
 * always comes from the campaign — two ranks disagreeing about the currency of
 * the same campaign produced totals that silently added dollars to Jamaican
 * dollars, so there is only one place it can be set.
 *
 * The result is shaped exactly like a commission_profiles row, so
 * commission-math does not need to know whether it was handed a live rank or a
 * snapshot taken months ago.
 */
function resolveTerms(profile, campaign) {
  if (!profile) return null;

  const campaignValue = campaign ? Number(campaign.deal_value) || 0 : 0;
  const ownValue = profile.deal_value === null || profile.deal_value === undefined
    ? null
    : Number(profile.deal_value);

  return {
    commission_profile_id: profile.id,
    profile_name: profile.name,
    initial_type: profile.initial_type,
    initial_value: Number(profile.initial_value) || 0,
    recurring_enabled: Boolean(profile.recurring_enabled),
    recurring_type: profile.recurring_type,
    recurring_value: Number(profile.recurring_value) || 0,
    recurring_months: profile.recurring_months === null || profile.recurring_months === undefined
      ? null
      : Number(profile.recurring_months),
    payout_day: Number(profile.payout_day) || 15,
    deal_value: ownValue === null || Number.isNaN(ownValue) ? campaignValue : ownValue,
    // Where the basis came from, so a statement can explain itself and an admin
    // can see at a glance whether a rank was overriding the campaign.
    deal_value_source: ownValue === null || Number.isNaN(ownValue) ? 'campaign' : 'rank',
    currency: (campaign && campaign.currency) || profile.currency || 'USD',
  };
}

/**
 * The snapshot written onto a lead at referral.
 *
 * Deliberately a plain object with no ids beyond the rank's, and a captured
 * timestamp: this is a record of a moment, not a pointer to a row that will
 * keep changing.
 */
function snapshot(profile, campaign, at = new Date()) {
  const terms = resolveTerms(profile, campaign);
  if (!terms) return null;
  return { ...terms, captured_at: new Date(at).toISOString(), version: 1 };
}

/**
 * The terms that govern one lead.
 *
 * Prefers the snapshot. Falls back to the live rank for leads referred before
 * snapshots existed — those keep the old behaviour rather than suddenly
 * calculating from nothing, which is the right way round: a missing snapshot
 * should degrade to what happened yesterday, not to zero.
 */
function termsForLead(lead, { profile, campaign } = {}) {
  if (lead && lead.terms && typeof lead.terms === 'object' && lead.terms.initial_type) {
    return lead.terms;
  }
  return resolveTerms(profile, campaign);
}

/** True when the snapshot is the source, rather than a live lookup. */
function isSnapshotted(lead) {
  return Boolean(lead && lead.terms && typeof lead.terms === 'object' && lead.terms.initial_type);
}

/**
 * Work out one commission from whatever terms apply to this lead.
 * Thin wrapper, but it keeps every caller on the same path.
 */
function amountFor(lead, kind, fallback = {}) {
  const terms = termsForLead(lead, fallback);
  if (!terms) return null;
  return calculate(terms, kind);
}

// ---------------------------------------------------------------------------
// Promotion
// ---------------------------------------------------------------------------

/**
 * Does this agent's record on a campaign earn the given rank?
 *
 * Every threshold that is SET must be met. An unset threshold is not a free
 * pass and not a bar — it simply is not a condition. Adding a second threshold
 * to an existing rank therefore tightens it, which is the safe direction for a
 * change to make.
 *
 * @param {object} rank   a commission_profiles row
 * @param {object} stats  { closedDeals, earned } for that agent on that campaign
 */
function qualifies(rank, stats = {}) {
  if (!rank || !rank.auto_promote) return false;

  const deals = Number(stats.closedDeals) || 0;
  const earned = Number(stats.earned) || 0;

  const needsDeals = rank.promote_after_deals !== null && rank.promote_after_deals !== undefined;
  const needsAmount = rank.promote_after_amount !== null && rank.promote_after_amount !== undefined;

  // A rank that promotes automatically but names no condition would promote
  // everyone the first time the job ran. The database refuses to store one;
  // this refuses to act on one that somehow exists.
  if (!needsDeals && !needsAmount) return false;

  if (needsDeals && deals < Number(rank.promote_after_deals)) return false;
  if (needsAmount && earned < Number(rank.promote_after_amount)) return false;

  return true;
}

/**
 * The rank an agent should be moved to, or null to leave them alone.
 *
 * Picks the most senior rank they qualify for, so an agent who blows past three
 * thresholds at once lands where they belong rather than climbing one step a
 * night. Never returns something at or below their current seniority.
 *
 * @param {object[]} ranks   active ranks on the campaign
 * @param {object|null} current  the rank they hold now
 * @param {object} stats
 */
function nextRankFor(ranks, current, stats) {
  const currentOrder = current ? Number(current.rank_order) || 0 : -Infinity;

  const eligible = (ranks || [])
    .filter((r) => r.status === 'active')
    .filter((r) => (Number(r.rank_order) || 0) > currentOrder)
    .filter((r) => qualifies(r, stats))
    .sort((a, b) => (Number(b.rank_order) || 0) - (Number(a.rank_order) || 0));

  return eligible[0] || null;
}

/** How a rank's requirements read to an agent. */
function requirementLabel(rank, money) {
  if (!rank || !rank.auto_promote) return '';
  const parts = [];
  if (rank.promote_after_deals) {
    parts.push(`${rank.promote_after_deals} closed deal${Number(rank.promote_after_deals) === 1 ? '' : 's'}`);
  }
  if (rank.promote_after_amount) {
    parts.push(`${money ? money(rank.promote_after_amount) : rank.promote_after_amount} earned`);
  }
  if (!parts.length) return '';
  return parts.join(' and ');
}

module.exports = {
  resolveTerms, snapshot, termsForLead, isSnapshotted, amountFor,
  qualifies, nextRankFor, requirementLabel,
};
