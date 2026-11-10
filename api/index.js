let app;

export default async function handler(req, res) {
  if (!res.req) res.req = req;
  try {
    if (!app) {
      const [{ createApp }, { openDb }, { config }] = await Promise.all([
        import('../src/server.js'),
        import('../src/db.js'),
        import('../src/config.js'),
      ]);
      const db = openDb(config.dbPath);
      app = createApp(db);
    }
    return await new Promise((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
      app.emit('request', req, res);
    });
  } catch (err) {
    console.error('Vercel handler error:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: err?.message ?? String(err), code: err?.code }));
  }
}
