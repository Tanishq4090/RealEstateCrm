let handle;

module.exports = async function handler(req, res) {
  if (req.url === '/__ping') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    return res.end('ok ' + process.version);
  }
  if (!res.req) res.req = req;
  try {
    if (!handle) {
      const [{ createHandler }, { openDb }, { config }] = await Promise.all([
        import('../src/server.js'),
        import('../src/db.js'),
        import('../src/config.js'),
      ]);
      const db = openDb(config.dbPath);
      handle = createHandler(db);
    }
    return await handle(req, res);
  } catch (err) {
    console.error('Vercel handler error:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: err?.message ?? String(err), code: err?.code }));
  }
};
