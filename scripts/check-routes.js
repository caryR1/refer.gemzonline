#!/usr/bin/env node
'use strict';

/**
 * Static wiring check: does every view a route renders actually exist, and does
 * every include and layout reference resolve?
 *
 *   node scripts/check-routes.js
 *
 * These mistakes are invisible until someone clicks the page, at which point
 * they are a 500. Cheap to catch here.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VIEWS = path.join(ROOT, 'views');

function walk(dir, filter, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, out);
    else if (filter(entry.name)) out.push(full);
  }
  return out;
}

const viewExists = (name) => fs.existsSync(path.join(VIEWS, `${name}.ejs`));
const rel = (p) => path.relative(ROOT, p);

const problems = [];

// --- routes: res.render('some/view') ---------------------------------------
const routeFiles = walk(path.join(ROOT, 'src'), (n) => n.endsWith('.js'));

for (const file of routeFiles) {
  const source = fs.readFileSync(file, 'utf8');
  const lines = source.split('\n');

  lines.forEach((line, i) => {
    const renders = line.matchAll(/\.render\(\s*['"]([\w\-./]+)['"]/g);
    for (const m of renders) {
      if (!viewExists(m[1])) {
        problems.push(`${rel(file)}:${i + 1}  renders "${m[1]}" — views/${m[1]}.ejs does not exist`);
      }
    }

    const layouts = line.matchAll(/layout:\s*['"]([\w\-./]+)['"]/g);
    for (const m of layouts) {
      if (!viewExists(m[1])) {
        problems.push(`${rel(file)}:${i + 1}  uses layout "${m[1]}" — views/${m[1]}.ejs does not exist`);
      }
    }
  });
}

// --- views: include('...') and layout('...') -------------------------------
const viewFiles = walk(VIEWS, (n) => n.endsWith('.ejs'));

for (const file of viewFiles) {
  const source = fs.readFileSync(file, 'utf8');
  const lines = source.split('\n');
  const dir = path.dirname(file);

  lines.forEach((line, i) => {
    const includes = line.matchAll(/include\(\s*['"]([\w\-./]+)['"]/g);
    for (const m of includes) {
      const target = m[1];
      const candidates = [
        path.resolve(dir, `${target}.ejs`),
        path.resolve(dir, target),
        path.join(VIEWS, `${target}.ejs`),
      ];
      if (!candidates.some((c) => fs.existsSync(c))) {
        problems.push(`${rel(file)}:${i + 1}  includes "${target}" — cannot resolve it`);
      }
    }

    const layouts = line.matchAll(/layout\(\s*['"]([\w\-./]+)['"]\s*\)/g);
    for (const m of layouts) {
      if (!viewExists(m[1])) {
        problems.push(`${rel(file)}:${i + 1}  sets layout "${m[1]}" — views/${m[1]}.ejs does not exist`);
      }
    }
  });
}

// --- routes: every router.use / mount target module resolves ---------------
for (const file of routeFiles) {
  const source = fs.readFileSync(file, 'utf8');
  const requires = source.matchAll(/require\(\s*['"](\.[\w\-./]+)['"]\s*\)/g);
  for (const m of requires) {
    const target = path.resolve(path.dirname(file), m[1]);
    const ok = fs.existsSync(target)
      || fs.existsSync(`${target}.js`)
      || fs.existsSync(`${target}.json`)
      || fs.existsSync(path.join(target, 'index.js'));
    if (!ok) problems.push(`${rel(file)}  requires "${m[1]}" — not found`);
  }
}

// --- views referenced by nothing (informational, not a failure) ------------
const rendered = new Set();
for (const file of routeFiles) {
  const source = fs.readFileSync(file, 'utf8');
  for (const m of source.matchAll(/\.render\(\s*['"]([\w\-./]+)['"]/g)) rendered.add(m[1]);
}
const included = new Set();
for (const file of viewFiles) {
  const source = fs.readFileSync(file, 'utf8');
  for (const m of source.matchAll(/include\(\s*['"]([\w\-./]+)['"]/g)) {
    included.add(path.relative(VIEWS, path.resolve(path.dirname(file), m[1])).replace(/\\/g, '/'));
  }
}

const orphans = viewFiles
  .map((f) => path.relative(VIEWS, f).replace(/\\/g, '/').replace(/\.ejs$/, ''))
  .filter((v) => !rendered.has(v) && !included.has(v) && !v.startsWith('layouts/'));

console.log(`Checked ${routeFiles.length} JS files and ${viewFiles.length} templates.`);

if (orphans.length) {
  console.log(`\nNot referenced anywhere (may be fine, may be dead):`);
  orphans.forEach((o) => console.log(`  views/${o}.ejs`));
}

if (problems.length) {
  console.error(`\n${problems.length} wiring problem${problems.length === 1 ? '' : 's'}:\n`);
  problems.forEach((p) => console.error(`  ${p}`));
  process.exit(1);
}

console.log('\nAll view, layout, include and require references resolve.');
