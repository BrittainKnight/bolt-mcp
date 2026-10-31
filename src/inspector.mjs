import http from 'node:http';
import fs from 'node:fs';
import { snapshot } from './ledger.mjs';
import { catalog } from './registry.mjs';

export async function serveInspector({ projectPath = process.cwd(), port = 5390 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  const assets = new Map([['/', ['index.html', 'text/html']], ['/inspector.css', ['inspector.css', 'text/css']], ['/inspector.mjs', ['inspector.mjs', 'text/javascript']]]);
  const server = http.createServer((request, response) => {
    const authority = request.headers.host;
    const allowed = new Set([`localhost:${server.address().port}`, `127.0.0.1:${server.address().port}`]);
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'", 'Referrer-Policy': 'no-referrer' };
    const reply = (status, type, body) => { response.writeHead(status, { ...headers, 'Content-Type': type + '; charset=utf-8' }); response.end(body); };
    if (!allowed.has(authority) || (request.headers.origin && ![`http://localhost:${server.address().port}`, `http://127.0.0.1:${server.address().port}`].includes(request.headers.origin))) return reply(403, 'text/plain', 'Forbidden');
    if (request.method !== 'GET') return reply(405, 'text/plain', 'Read-only inspector');
    if (request.url === '/favicon.ico') return reply(204, 'image/x-icon', '');
    if (request.url === '/api/status') {
      try { return reply(200, 'application/json', JSON.stringify({ ...snapshot(projectPath), registry: catalog() })); }
      catch (error) { return reply(409, 'application/json', JSON.stringify({ error: error.message })); }
    }
    const asset = assets.get(request.url);
    if (!asset) return reply(404, 'text/plain', 'Not found');
    reply(200, asset[1], fs.readFileSync(new URL(`../web/${asset[0]}`, import.meta.url)));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}
