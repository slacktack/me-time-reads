import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { handle } from './handlers.js';

const PORT = process.env.PORT || 5173;
const ROOT = path.join(import.meta.dirname, 'public');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

async function serveStatic(res, pathname) {
  const file = path.normalize(path.join(ROOT, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

http.createServer(async (req, res) => {
  if (!(await handle(req, res))) serveStatic(res, decodeURIComponent(new URL(req.url, 'http://x').pathname));
}).listen(PORT, '0.0.0.0', () => {
  const lan = Object.values(os.networkInterfaces()).flat().find(i => i.family === 'IPv4' && !i.internal);
  console.log(`Reader on http://localhost:${PORT}${lan ? `  (phone: http://${lan.address}:${PORT})` : ''}`);
});
