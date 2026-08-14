import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist');
const sources = [
  ['/index.html', 'index.html', 'text/html; charset=utf-8'],
  ['/assets/editor.js', 'assets/editor.js', 'text/javascript; charset=utf-8'],
  ['/assets/editor.css', 'assets/editor.css', 'text/css; charset=utf-8'],
];

const assets = {};
for (const [urlPath, filePath, contentType] of sources) {
  const body = await readFile(path.join(root, filePath));
  assets[urlPath] = { contentType, body: body.toString('base64') };
}

const worker = `const assets = ${JSON.stringify(assets)};
const decode = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

export default {
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const url = new URL(request.url);
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname.replace(/\\/$/, "/index.html");
    const asset = assets[pathname];
    if (!asset) return new Response("Not Found", { status: 404 });
    return new Response(request.method === "HEAD" ? null : decode(asset.body), {
      headers: {
        "Content-Type": asset.contentType,
        "Cache-Control": "no-store, max-age=0",
        "X-Content-Type-Options": "nosniff"
      }
    });
  }
};
`;

await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, 'server'), { recursive: true });
await writeFile(path.join(output, 'server/index.js'), worker);
