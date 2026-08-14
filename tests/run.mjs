import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = ['dynamic-export.html', 'annotated-ai.html'];
const chrome = [
  process.env.HTMLIVE_CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((candidate) => candidate && existsSync(candidate));
if (!chrome) throw new Error('Chrome not found; set HTMLIVE_CHROME_BIN to run the browser test');
for (const fixtureName of fixtures) {
  const fixture = pathToFileURL(path.join(root, 'tests/fixtures', fixtureName)).href;
  const html = execFileSync(chrome, [
    '--headless',
    '--disable-gpu',
    '--allow-file-access-from-files',
    '--virtual-time-budget=7000',
    '--dump-dom',
    fixture,
  ], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });

  const match = html.match(/<output id="test-result"[^>]*>([^<]*)<\/output>/);
  if (!match || !/data-status="pass"/.test(match[0])) {
    throw new Error(`HTMLive browser test failed (${fixtureName}): ${match?.[1] || 'missing result'}`);
  }
}
console.log('HTMLive browser tests passed');
