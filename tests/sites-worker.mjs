import assert from 'node:assert/strict';

const { default: worker } = await import('../dist/server/index.js');
const response = await worker.fetch(new Request('https://htmlive.test/assets/editor.js'));

assert.equal(response.status, 200);
assert.match(response.headers.get('cache-control') || '', /no-(?:cache|store)/, 'bookmarklet assets must not be served from a stale browser cache');
console.log('HTMLive Sites worker tests passed');
