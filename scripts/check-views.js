#!/usr/bin/env node
'use strict';

/**
 * Compile every .ejs template to JavaScript and syntax-check it, without
 * needing the ejs package installed. This mirrors what EJS does at render
 * time, so it catches the mistakes that actually happen in templates:
 * unbalanced if/forEach blocks, stray delimiters, broken expressions.
 *
 *   node scripts/check-views.js
 */

const fs = require('fs');
const path = require('path');

const VIEWS = path.join(__dirname, '..', 'views');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ejs')) out.push(full);
  }
  return out;
}

/** Turn template source into the JS body EJS would generate. */
function compile(source) {
  const parts = [];
  const re = /<%(%|=|-|#|_)?([\s\S]*?)(-|_)?%>/g;
  let last = 0;
  let match;

  while ((match = re.exec(source)) !== null) {
    last = re.lastIndex;
    const type = match[1];
    const code = match[2];

    if (type === '%') continue;          // literal <%
    if (type === '#') continue;          // comment
    if (type === '=' || type === '-') {
      parts.push(`__append(${code.trim() === '' ? "''" : code});`);
    } else {
      parts.push(code);                  // scriptlet
    }
  }
  void last;

  return `let __output=''; function __append(s){__output+=s;}\n${parts.join('\n')}\nreturn __output;`;
}

const files = walk(VIEWS).sort();
let failures = 0;

for (const file of files) {
  const rel = path.relative(path.join(__dirname, '..'), file);
  const source = fs.readFileSync(file, 'utf8');

  // Unbalanced delimiters are worth catching on their own — they produce
  // confusing downstream errors otherwise.
  const opens = (source.match(/<%/g) || []).length;
  const closes = (source.match(/%>/g) || []).length;
  if (opens !== closes) {
    console.error(`FAIL ${rel}\n  unbalanced delimiters: ${opens} "<%" vs ${closes} "%>"`);
    failures += 1;
    continue;
  }

  // `layout('layouts/bare')` inside a template is ejs-locals syntax. This
  // project uses express-ejs-layouts, where the layout is chosen by passing
  // `layout: 'layouts/bare'` in the render options. The call compiles fine and
  // only throws "layout is not defined" when the page is actually rendered --
  // which, for an error page, is the first moment something else has already
  // gone wrong and you can least afford a second fault. Catch it here.
  if (/<%[^%]*\blayout\s*\(/.test(source)) {
    console.error(`FAIL ${rel}\n  calls layout(...) inside the template. express-ejs-layouts does not`
      + `\n  define that function. Pass { layout: 'layouts/bare' } in the render options instead.`);
    failures += 1;
    continue;
  }

  try {
    // Only the locals EJS actually provides. Do not add 'layout' to this list:
    // having it there kept the checker green while every render of the two
    // error pages threw ReferenceError.
    // eslint-disable-next-line no-new-func
    new Function('locals', 'include', compile(source));
  } catch (err) {
    console.error(`FAIL ${rel}\n  ${err.message}`);
    failures += 1;
  }
}

if (failures) {
  console.error(`\n${failures} of ${files.length} templates failed to compile.`);
  process.exit(1);
}

console.log(`All ${files.length} templates compile cleanly.`);
