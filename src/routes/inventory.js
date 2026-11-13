'use strict';
/* Inventário automático (agentes) e importação de CSV / Excel. */
// Os nomes importados abaixo são partilhados por todos os módulos de rotas; nem todos são usados aqui.
/* eslint-disable no-unused-vars */
const {
  STATUSES, CRITICALITIES, ENVIRONMENTS, REL_TYPES, ROLES, CI_TEXT_FIELDS, CSV_COLUMNS, SESSION_TTL_MS, LOGIN_WINDOW_MS, LOGIN_MAX_FAILS, MIME, SECURITY_HEADERS, HttpError, fail, toId, str, reqStr, oneOf, isoDate, cleanAttributes, parseCookies, csvCell, readBody,
} = require('../http');
const { hashPassword, verifyPassword, newToken, sha256 } = require('../auth');
const totp = require('../totp');
module.exports = function register(core) {
  const {
    db, opts, log, add, one, all, run, tx, audit, scopeOf, scopeSql, assertRead, assertWrite, assertAdmin, publicUser, meView, mfaSetupRequired, passwordChangeRequired, checkPassword, getClient, getCi, addCookie, setSessionCookie, createSession, redirect, box, oidc, requireMfa, totpIssuer, fetchFn, secureCookie, state, reconciler,
  } = core;


  // =========================================================== inventário automático
  // POST /api/v1/ingest   Authorization: Bearer <token do cliente>
  // Corpo: um ativo, ou { "assets": [ ... ] } (máx. 500 por pedido).
  add('POST', '/api/ingest', ({ req, body }) => {
    const tok = core.requireToken(req, 'ingest');
    const assets = Array.isArray(body.assets) ? body.assets : [body];
    const actor = `agente:${tok.name}`;

    // Reconciliação: external_id → nº de série → hostname (dentro do mesmo cliente)
    const results = tx(() => assets.map((a, i) => {
      if (!a || typeof a !== 'object') fail(400, `Ativo #${i}: formato inválido`);
      try {
        const res = reconciler.upsert(tok.client_id, a, actor, 'agent');
        if (Array.isArray(a.software)) res.software = core.cve.setSoftware(res.id, a.software);
        return res;
      } catch (e) {
        if (e instanceof HttpError) throw e;
        if (/constraint/i.test(e.message)) throw e;
        return fail(400, `Ativo #${i}: ${e.message}`);
      }
    }));
    return { results };
  }, {
    public: true, token: true, api: true, maxBody: 5 * 1024 * 1024, body: require('../api-schemas').ingest, scope: 'ingest', tag: 'Inventário',
    summary: 'Enviar inventário de ativos',
    description: 'Cria ou atualiza ativos do cliente do token. Reconciliação por external_id, depois nº de série, depois hostname, sem criar duplicados.',
  });

  // =========================================================== importação
  // Corre numa worker thread (ver src/jobs.js): uma importação grande não bloqueia os outros pedidos
  add('POST', '/api/import', async ({ user, body }) => {
    const clientId = toId(body.client_id, 'Cliente');
    assertWrite(user, clientId);
    return core.runJob('import', {
      user: { id: user.id, username: user.username }, clientId, rows: body.rows,
      options: { dryRun: body.dry_run !== false, update: body.update !== false, createSites: body.create_sites !== false },
    });
  }, { maxBody: 20 * 1024 * 1024 });
};
