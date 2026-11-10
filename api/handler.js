import { handle } from '../handlers.js';

export default async function handler(req, res) {
  if (!(await handle(req, res))) res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"Not found"}');
}
