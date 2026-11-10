import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { config } from '../src/config.js';

let app;

export default function handler(req, res) {
  if (!res.req) res.req = req;
  try {
    if (!app) {
      const db = openDb(config.dbPath);
      app = createApp(db);
    }
    return new Promise((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
      app.emit('request', req, res);
    });
  } catch (err) {
    console.error('Vercel handler startup error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
}
