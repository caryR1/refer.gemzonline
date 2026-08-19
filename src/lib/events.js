'use strict';

/**
 * The catalogue of notification events.
 *
 * Everything that can be sent is declared here once: the trigger key, who it
 * can go to, and whether it appears in a user's preference screen. The
 * notification service, the preferences UI and the template editor all read
 * from this list, so adding an event is a one-line change.
 */

const EVENTS = [
  {
    key: 'lead_created',
    label: 'New lead captured',
    description: 'A prospect submitted the referral form.',
    recipients: ['lead', 'agent', 'admin'],
    userConfigurable: true,
  },
  {
    key: 'consent_given',
    label: 'Acknowledgement completed',
    description: 'The prospect confirmed their details and gave consent.',
    recipients: ['lead', 'agent', 'admin'],
    userConfigurable: true,
  },
  {
    key: 'appointment_set',
    label: 'Appointment set',
    description: 'Primary and backup times were chosen.',
    recipients: ['lead', 'agent', 'admin'],
    userConfigurable: true,
  },
  {
    key: 'appointment_rescheduled',
    label: 'Appointment rescheduled',
    description: 'The prospect changed their appointment from their own link.',
    recipients: ['lead', 'agent', 'admin'],
    userConfigurable: true,
  },
  {
    key: 'prospect_cancelled',
    label: 'Prospect cancelled',
    description: 'The prospect cancelled from their own link. The lead is closed as lost.',
    recipients: ['agent', 'admin'],
    userConfigurable: true,
  },
  {
    key: 'contacted',
    label: 'Lead marked contacted',
    description: 'Status moved to contacted.',
    recipients: ['lead', 'agent'],
    userConfigurable: true,
  },
  {
    key: 'closed_won',
    label: 'Lead closed / won',
    description: 'Admin closed the lead as won. A commission is created.',
    recipients: ['agent', 'admin'],
    userConfigurable: true,
  },
  {
    key: 'closed_lost',
    label: 'Lead closed / lost',
    description: 'Admin closed the lead as lost.',
    recipients: ['agent', 'admin'],
    userConfigurable: true,
  },
  {
    key: 'commission_approved',
    label: 'Commission approved',
    description: 'A commission moved from pending to approved.',
    recipients: ['agent'],
    userConfigurable: true,
  },
  {
    key: 'commission_paid',
    label: 'Commission paid',
    description: 'A commission was marked paid.',
    recipients: ['agent'],
    userConfigurable: true,
  },
  {
    key: 'account_dropped',
    label: 'Recurring account cancelled',
    description: 'An active recurring account was switched off. Accrual stops.',
    recipients: ['agent', 'admin'],
    userConfigurable: true,
  },
  {
    key: 'monthly_report',
    label: 'Monthly commission report',
    description: 'The month-end statement.',
    recipients: ['agent', 'admin'],
    userConfigurable: true,
  },
  {
    key: 'monthly_account_review',
    label: 'Monthly recurring-account review',
    description: 'Admin-only list of every currently active recurring account.',
    recipients: ['admin'],
    userConfigurable: true,
  },
  {
    key: 'stale_lead',
    label: 'Stale lead alert',
    description: 'Leads sitting untouched past the configured threshold.',
    recipients: ['agent', 'admin'],
    userConfigurable: true,
  },
  {
    key: 'appointment_reminder',
    label: 'Appointment reminder',
    description: 'Campaign reminder slots. Configured per campaign, not per user.',
    recipients: ['lead', 'agent', 'admin'],
    userConfigurable: true,
  },
  {
    key: 'welcome',
    label: 'Campaign welcome message',
    description: 'Campaign-specific welcome, carrying the prospect self-service link.',
    recipients: ['lead'],
    userConfigurable: false,
  },
];

const EVENT_KEYS = EVENTS.map((e) => e.key);
const EVENT_MAP = Object.fromEntries(EVENTS.map((e) => [e.key, e]));

/** Events that appear in a staff member's preference screen. */
function staffEvents() {
  return EVENTS.filter((e) => e.userConfigurable && (e.recipients.includes('agent') || e.recipients.includes('admin')));
}

function label(key) {
  return EVENT_MAP[key] ? EVENT_MAP[key].label : key;
}

/** Options for the template editor's trigger dropdown. */
function triggerOptions() {
  return [{ value: '', label: 'Manual only — never sent automatically' }]
    .concat(EVENTS.map((e) => ({ value: e.key, label: e.label })));
}

module.exports = { EVENTS, EVENT_KEYS, EVENT_MAP, staffEvents, label, triggerOptions };
