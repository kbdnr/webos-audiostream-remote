#!/usr/bin/env node
/*
 * Keeps every version field in step with package.json:
 *   node scripts/bump-version.js          bump the patch version, then sync (npm run build)
 *   node scripts/bump-version.js --sync   only sync (npm version hook, after npm bumped it)
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const write = (f, json) => fs.writeFileSync(path.join(root, f), JSON.stringify(json, null, 2) + '\n');

const pkg = read('package.json');
if (!process.argv.includes('--sync')) {
  const [major, minor, patch] = pkg.version.split('.').map(Number);
  pkg.version = `${major}.${minor}.${patch + 1}`;
  write('package.json', pkg);
}

for (const f of ['frontend/appinfo.json', 'service/package.json']) {
  const json = read(f);
  json.version = pkg.version;
  write(f, json);
}

if (fs.existsSync(path.join(root, 'package-lock.json'))) {
  const lock = read('package-lock.json');
  lock.version = pkg.version;
  if (lock.packages && lock.packages['']) lock.packages[''].version = pkg.version;
  write('package-lock.json', lock);
}

console.log(`version ${pkg.version}`);
