'use strict';
/* Apoio aos testes: arranca a aplicação numa porta livre e cria clientes HTTP com cookie de sessão. */
const http = require('node:http');
const assert = require('node:assert/strict');
const { openDb, ensureAdmin } = require('../src/db');
const { createApp } = require('../src/app');

async function startServer({ adminPassword = 'Admin-pass-123', appOpts = {}, db: givenDb } = {}) {
  const db = givenDb || openDb(':memory:');
  if (adminPassword !== null) ensureAdmin(db, adminPassword);
  const app = createApp(db, appOpts);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  function agent() {
    let cookie = '';
    const call = async (method, path, body, headers = {}) => {
      const res = await fetch(base + path, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const ct = res.headers.get('content-type') || '';
      let data;
      if (ct.includes('json')) data = await res.json();
      else if (/spreadsheet|octet-stream/.test(ct)) data = Buffer.from(await res.arrayBuffer());
      else data = await res.text();
      return { status: res.status, data, headers: res.headers };
    };
    return {
      get: (p, h) => call('GET', p, undefined, h), post: (p, b, h) => call('POST', p, b, h),
      put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p),
      async login(username, password) {
        const r = await call('POST', '/api/login', { username, password });
        assert.equal(r.status, 200, JSON.stringify(r.data));
        return r.data;
      },
    };
  }

  return {
    db, app, base, agent,
    close: () => new Promise((r) => { server.close(() => { db.close(); r(); }); }),
  };
}

module.exports = { startServer };
