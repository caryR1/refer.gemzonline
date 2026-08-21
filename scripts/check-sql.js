#!/usr/bin/env node
'use strict';

/**
 * Catch the one SQL mistake the other checks cannot see.
 *
 *   node scripts/check-sql.js
 *
 * Postgres infers a type for every $n by looking at how it is used. Use the
 * same parameter two ways in one statement and it gives up:
 *
 *   update leads set status = $2,                       -- $2 is lead_status
 *          account_active = case when $2 = 'closed_won' -- $2 is text
 *
 *   ERROR: inconsistent types deduced for parameter $2
 *
 * The query is refused whole, at execution, on a real database. It compiles, it
 * passes every static check, the unit tests never touch a database, and the
 * route looks entirely reasonable in review. This app shipped four of them and
 * found the first only when a live admin changed a lead's status in production.
 *
 * The fix is always the same: bind the parameter as text and cast it where it
 * is assigned — `status = $2::lead_status` — so both readings agree.
 *
 * The fingerprint is narrow enough to detect: one parameter that is both
 * assigned to a column WITHOUT a cast and compared against a quoted literal.
 */

const fs = require('fs');
const path = require('path');

const ROOTS = ['src', 'scripts'];
const BASE = path.join(__dirname, '..');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Template literals that look like SQL carrying parameters. */
function sqlLiterals(source) {
  const found = [];
  const re = /`([^`\\]*(?:\\.[^`\\]*)*)`/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const body = m[1];
    if (!/\$\d/.test(body)) continue;
    if (!/\b(select|insert|update|delete|with)\b/i.test(body)) continue;
    found.push({ text: body, index: m.index });
  }
  return found;
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

const files = ROOTS.flatMap((r) => walk(path.join(BASE, r))).sort();
let failures = 0;
let statements = 0;

for (const file of files) {
  const rel = path.relative(BASE, file);
  const source = fs.readFileSync(file, 'utf8');

  for (const stmt of sqlLiterals(source)) {
    statements += 1;

    // `col = $2` with no cast — Postgres takes the parameter's type from the
    // column, which for an enum column is the enum.
    const assigned = new Set();
    const assignRe = /\b\w+\s*=\s*\$(\d+)(?!\s*::)/g;
    let a;
    while ((a = assignRe.exec(stmt.text)) !== null) assigned.add(a[1]);

    // `$2 = 'closed_won'` — two unknowns, so Postgres falls back to text.
    const compared = new Set();
    const compareRe = /\$(\d+)\s*(?:=|<>|!=)\s*'/g;
    let c;
    while ((c = compareRe.exec(stmt.text)) !== null) compared.add(c[1]);

    const clashes = [...assigned].filter((n) => compared.has(n));
    if (!clashes.length) continue;

    for (const n of clashes) {
      console.error(
        `FAIL ${rel}:${lineOf(source, stmt.index)}\n`
        + `  $${n} is assigned to a column AND compared to a quoted literal in the same\n`
        + `  statement. Postgres will deduce two types for it and refuse the query at\n`
        + `  execution with "inconsistent types deduced for parameter $${n}".\n`
        + `  Cast it where it is assigned, e.g. \`col = $${n}::lead_status\`, so the\n`
        + `  parameter itself stays text and both readings agree.`
      );
      failures += 1;
    }
  }
}

if (failures) {
  console.error(`\n${failures} parameter${failures === 1 ? '' : 's'} would fail at execution.`);
  process.exit(1);
}

console.log(`Checked ${statements} SQL statements. No conflicting parameter types.`);
