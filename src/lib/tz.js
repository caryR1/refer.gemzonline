'use strict';

/**
 * Timezone helpers.
 *
 * House rules:
 *  - Everything is stored in Postgres as `timestamptz` (UTC on the wire).
 *  - Staff (admin + agents) always see STAFF_TIMEZONE — Jamaica, UTC-5, no DST.
 *  - Prospects see, and pick appointments in, their own timezone.
 *  - Emails that mention a time show BOTH: the prospect's local time and
 *    Jamaica time, so nobody has to do the arithmetic.
 */

const { DateTime } = require('luxon');
const config = require('../config');

const STAFF_TZ = config.staffTimezone;

/** A generous, deduped list of IANA zones for the prospect-facing picker. */
const COMMON_TIMEZONES = [
  'America/Jamaica', 'America/New_York', 'America/Chicago', 'America/Denver',
  'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu',
  'America/Toronto', 'America/Vancouver', 'America/Halifax', 'America/St_Johns',
  'America/Mexico_City', 'America/Bogota', 'America/Lima', 'America/Santiago',
  'America/Sao_Paulo', 'America/Argentina/Buenos_Aires', 'America/Panama',
  'America/Port_of_Spain', 'America/Puerto_Rico', 'America/Nassau', 'America/Havana',
  'Atlantic/Bermuda', 'Europe/London', 'Europe/Dublin', 'Europe/Lisbon',
  'Europe/Madrid', 'Europe/Paris', 'Europe/Brussels', 'Europe/Amsterdam',
  'Europe/Berlin', 'Europe/Zurich', 'Europe/Rome', 'Europe/Vienna',
  'Europe/Warsaw', 'Europe/Stockholm', 'Europe/Oslo', 'Europe/Copenhagen',
  'Europe/Helsinki', 'Europe/Athens', 'Europe/Bucharest', 'Europe/Kyiv',
  'Europe/Istanbul', 'Europe/Moscow', 'Africa/Lagos', 'Africa/Accra',
  'Africa/Nairobi', 'Africa/Johannesburg', 'Africa/Cairo', 'Asia/Jerusalem',
  'Asia/Dubai', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Bangkok',
  'Asia/Jakarta', 'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Shanghai',
  'Asia/Manila', 'Asia/Seoul', 'Asia/Tokyo', 'Australia/Perth',
  'Australia/Adelaide', 'Australia/Brisbane', 'Australia/Sydney',
  'Australia/Melbourne', 'Pacific/Auckland', 'Pacific/Fiji', 'UTC',
];

function isValidZone(zone) {
  if (!zone || typeof zone !== 'string') return false;
  return DateTime.local().setZone(zone).isValid;
}

function safeZone(zone, fallback = STAFF_TZ) {
  return isValidZone(zone) ? zone : fallback;
}

/**
 * Convert a wall-clock date + time typed by a user in `zone` into a real
 * Date (UTC instant). Returns null if the input is incomplete or invalid.
 */
function localInputToDate(dateStr, timeStr, zone) {
  if (!dateStr || !timeStr) return null;
  const dt = DateTime.fromISO(`${dateStr}T${timeStr}`, { zone: safeZone(zone) });
  return dt.isValid ? dt.toJSDate() : null;
}

/** Format an instant in a given zone. */
function fmt(value, zone = STAFF_TZ, format = 'ccc, LLL d yyyy • h:mm a ZZZZ') {
  if (!value) return '';
  const dt = value instanceof Date
    ? DateTime.fromJSDate(value)
    : DateTime.fromISO(String(value));
  if (!dt.isValid) return '';
  return dt.setZone(safeZone(zone)).toFormat(format);
}

/** Short date only, staff zone by default. */
function fmtDate(value, zone = STAFF_TZ) {
  return fmt(value, zone, 'LLL d, yyyy');
}

/** Date + time, no zone label. */
function fmtShort(value, zone = STAFF_TZ) {
  return fmt(value, zone, 'LLL d, yyyy h:mm a');
}

/** Staff-timezone rendering (Jamaica). */
function fmtStaff(value) {
  return fmt(value, STAFF_TZ);
}

/**
 * Render an appointment for an email or a page: prospect's local time first,
 * Jamaica time second. Falls back gracefully when the zones match.
 */
function fmtDual(value, prospectZone) {
  if (!value) return '';
  const zone = safeZone(prospectZone);
  const local = fmt(value, zone);
  if (zone === STAFF_TZ) return local;
  return `${local}  (${fmt(value, STAFF_TZ, 'h:mm a ZZZZ')} Jamaica time)`;
}

/** Relative "3 days ago" style label. */
function fmtRelative(value) {
  if (!value) return '';
  const dt = value instanceof Date ? DateTime.fromJSDate(value) : DateTime.fromISO(String(value));
  if (!dt.isValid) return '';
  return dt.toRelative({ base: DateTime.now() }) || '';
}

/** Current instant. */
function now() {
  return new Date();
}

/** Start of the given month (in staff zone) as a JS Date. */
function monthStart(offsetMonths = 0, zone = STAFF_TZ) {
  return DateTime.now().setZone(safeZone(zone)).startOf('month').plus({ months: offsetMonths }).toJSDate();
}

/** `YYYY-MM-01` string used as the commission period key. */
function periodKey(value = new Date(), zone = STAFF_TZ) {
  const dt = value instanceof Date ? DateTime.fromJSDate(value) : DateTime.fromISO(String(value));
  return dt.setZone(safeZone(zone)).startOf('month').toFormat('yyyy-LL-dd');
}

/** Human label for a period key, e.g. "August 2026". */
function periodLabel(key) {
  const dt = DateTime.fromISO(String(key).slice(0, 10));
  return dt.isValid ? dt.toFormat('LLLL yyyy') : String(key);
}

/** `YYYY-MM-DD` in the given zone — used for date input defaults. */
function isoDate(value = new Date(), zone = STAFF_TZ) {
  const dt = value instanceof Date ? DateTime.fromJSDate(value) : DateTime.fromISO(String(value));
  return dt.setZone(safeZone(zone)).toFormat('yyyy-LL-dd');
}

/**
 * The two halves of a date+time input pair, in a given zone.
 *
 * `inputTime` is deliberately 24-hour: that is what `<input type="time">`
 * submits and expects however the browser chooses to display it, so a field
 * left untouched round-trips through an edit unchanged.
 *
 * Both return '' rather than today's date for an absent value — an empty
 * appointment field must look empty, not pre-filled with a time nobody chose.
 */
function inputDate(value, zone = STAFF_TZ) {
  if (!value) return '';
  const dt = value instanceof Date ? DateTime.fromJSDate(value) : DateTime.fromISO(String(value));
  return dt.isValid ? dt.setZone(safeZone(zone)).toFormat('yyyy-LL-dd') : '';
}

function inputTime(value, zone = STAFF_TZ) {
  if (!value) return '';
  const dt = value instanceof Date ? DateTime.fromJSDate(value) : DateTime.fromISO(String(value));
  return dt.isValid ? dt.setZone(safeZone(zone)).toFormat('HH:mm') : '';
}

module.exports = {
  STAFF_TZ,
  COMMON_TIMEZONES,
  isValidZone,
  safeZone,
  localInputToDate,
  inputDate,
  inputTime,
  fmt,
  fmtDate,
  fmtShort,
  fmtStaff,
  fmtDual,
  fmtRelative,
  now,
  monthStart,
  periodKey,
  periodLabel,
  isoDate,
};
