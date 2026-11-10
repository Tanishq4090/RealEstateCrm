import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { config } from '../src/config.js';

let app;

export default function handler(req, res) {
  if (!app) {
    const db = openDb(config.dbPath);
    app = createApp(db);
  }
  return app.emit('request', req, res);
}

