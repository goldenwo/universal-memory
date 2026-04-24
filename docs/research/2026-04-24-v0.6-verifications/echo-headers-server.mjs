#!/usr/bin/env node
// V3 — echo-headers server
// Logs every inbound request's headers as a JSON line for later scan.
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PORT = parseInt(process.env.PORT || '6336', 10);
const LOG_FILE = resolve(process.env.LOG_FILE || '/tmp/cc-headers.log');

createServer((req, res) => {
  const entry = {
    ts: new Date().toISOString(),
    method: req.method,
    url: req.url,
    remoteAddr: req.socket.remoteAddress,
    headers: req.headers,
  };
  const line = JSON.stringify(entry) + '\n';
  process.stdout.write(line);
  writeFileSync(LOG_FILE, line, { flag: 'a' });

  // Minimal responses so CC/MCP doesn't error out. Fake a trivial envelope.
  res.setHeader('Content-Type', 'application/json');
  if (req.url?.startsWith('/api/list') || req.url?.startsWith('/api/search') || req.url?.startsWith('/api/recent')) {
    res.end(JSON.stringify({ results: [] }));
  } else if (req.url === '/mcp') {
    // Minimal MCP handshake reply
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, result: { content: [{ type: 'text', text: '' }] } }));
  } else if (req.url === '/health') {
    res.end(JSON.stringify({ ok: true, memories: 0 }));
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'stub' }));
  }
}).listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`[echo-headers] listening on http://127.0.0.1:${PORT} logging to ${LOG_FILE}\n`);
});
