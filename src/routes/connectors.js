'use strict';
/* Conector Microsoft 365 / Azure: configuração e sincronização. */
// Os nomes importados abaixo são partilhados por todos os módulos de rotas; nem todos são usados aqui.
/* eslint-disable no-unused-vars */
const {
  STATUSES, CRITICALITIES, ENVIRONMENTS, REL_TYPES, ROLES, CI_TEXT_FIELDS, CSV_COLUMNS, SESSION_TTL_MS, LOGIN_WINDOW_MS, LOGIN_MAX_FAILS, MIME, SECURITY_HEADERS, HttpError, fail, toId, str, reqStr, oneOf, isoDate, cleanAttributes, parseCookies, csvCell, readBody,
} = require('../http');
const { hashPassword, verifyPassword, newToken, sha256 } = require('../auth');
const totp = require('../totp');
const { syncMicrosoft } = require('../cloud');
module.exports = function register(core) {
  const {
    db, opts, log, add, one, all, run, tx, audit, scopeOf, scopeSql, assertRead, assertWrite, assertAdmin, publicUser, meView, mfaSetupRequired, passwordChangeRequired, checkPassword, getClient, getCi, addCookie, setSessionCookie, createSession, redirect, box, oidc, requireMfa, totpIssuer, fetchFn, secureCookie, state, reconciler,
  } = core;

  // =========================================================== conector Microsoft 365 / Azure
  const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const connectorView = (c) => (c ? {
    id: c.id, client_id: c.client_id, provider: c.provider, tenant_id: c.tenant_id, app_id: c.app_id,
    options: JSON.parse(c.options), enabled: !!c.enabled, last_sync: c.last_sync, last_status: c.last_status,
    last_report: c.last_report ? JSON.parse(c.last_report) : null,
  } : null);

  async function syncConnector(id, actor) {
    const con = one('SELECT * FROM cloud_connectors WHERE id = ?', id);
    if (!con) fail(404, 'Conector não configurado');
    // Lock na BD (e não em memória): só uma instância sincroniza cada conector de cada vez
    if (!state.locks.acquire(`sync:${id}`, 15 * 60e3)) fail(409, 'Já existe uma sincronização em curso para este cliente');
    try {
      let report;
      try {
        let secret;
        try { secret = box.open(con.secret_enc); } catch {
          throw new Error('Não foi possível desencriptar o segredo (a chave CMDB_SECRET_KEY mudou?). Volte a guardar o segredo.');
        }
        report = await syncMicrosoft({
          clientId: con.client_id, tenantId: con.tenant_id, appId: con.app_id, secret,
          options: JSON.parse(con.options), fetchFn, reconciler, tx,
        });
      } catch (e) {
        report = { licencas: null, dispositivos: null, azure: null, erros: [e.message] };
      }
      const anyOk = ['licencas', 'dispositivos', 'azure'].some((k) => report[k]);
      const status = !report.erros.length ? 'ok' : anyOk ? 'parcial' : 'erro';
      run("UPDATE cloud_connectors SET last_sync = datetime('now'), last_status = ?, last_report = ? WHERE id = ?",
        status, JSON.stringify(report), id);
      audit('connector', id, con.client_id, 'Microsoft 365 / Azure', actor, 'sync', { estado: status });
      return { status, report };
    } finally {
      state.locks.release(`sync:${id}`);
    }
  }

  add('GET', '/api/clients/:id/connector', ({ user, params }) => {
    assertAdmin(user);
    const c = getClient(user, params.id);
    return connectorView(one('SELECT * FROM cloud_connectors WHERE client_id = ?', c.id));
  });

  add('PUT', '/api/clients/:id/connector', ({ user, params, body }) => {
    assertAdmin(user);
    const c = getClient(user, params.id);
    const tenant = reqStr(body.tenant_id, 'Tenant ID', 100);
    if (!GUID.test(tenant) && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(tenant)) fail(400, 'Tenant ID: GUID ou domínio (ex.: contoso.onmicrosoft.com)');
    const appId = reqStr(body.app_id, 'Application (client) ID', 100);
    if (!GUID.test(appId)) fail(400, 'O Application (client) ID tem de ser um GUID');
    const o = body.options || {};
    const options = { licenses: !!o.licenses, intune: !!o.intune, azure: !!o.azure };
    if (!options.licenses && !options.intune && !options.azure) fail(400, 'Escolha pelo menos uma origem de dados');
    const secret = str(body.secret, 500);
    const enabled = body.enabled === false ? 0 : 1;
    const existing = one('SELECT * FROM cloud_connectors WHERE client_id = ?', c.id);
    if (!existing && !secret) fail(400, 'O segredo (client secret) é obrigatório');
    if (existing) {
      run(`UPDATE cloud_connectors SET tenant_id = ?, app_id = ?, options = ?, enabled = ?${secret ? ', secret_enc = ?' : ''} WHERE id = ?`,
        tenant, appId, JSON.stringify(options), enabled, ...(secret ? [box.seal(secret)] : []), existing.id);
    } else {
      run('INSERT INTO cloud_connectors (client_id, tenant_id, app_id, secret_enc, options, enabled) VALUES (?,?,?,?,?,?)',
        c.id, tenant, appId, box.seal(secret), JSON.stringify(options), enabled);
    }
    const saved = one('SELECT * FROM cloud_connectors WHERE client_id = ?', c.id);
    audit('connector', saved.id, c.id, 'Microsoft 365 / Azure', user.username, existing ? 'update' : 'create',
      { tenant_id: tenant, app_id: appId, ...options, ativo: !!enabled, segredo: secret ? '(alterado)' : undefined });
    return connectorView(saved);
  });

  add('DELETE', '/api/clients/:id/connector', ({ user, params }) => {
    assertAdmin(user);
    const c = getClient(user, params.id);
    const con = one('SELECT * FROM cloud_connectors WHERE client_id = ?', c.id);
    if (!con) fail(404, 'Conector não configurado');
    run('DELETE FROM cloud_connectors WHERE id = ?', con.id);
    audit('connector', con.id, c.id, 'Microsoft 365 / Azure', user.username, 'delete');
    return { ok: true };
  });

  add('POST', '/api/clients/:id/connector/sync', async ({ user, params }) => {
    assertAdmin(user);
    const c = getClient(user, params.id);
    const con = one('SELECT id FROM cloud_connectors WHERE client_id = ?', c.id);
    if (!con) fail(404, 'Conector não configurado');
    return syncConnector(con.id, user.username);
  });
  const dueConnectors = (hours) => all(`SELECT id FROM cloud_connectors WHERE enabled = 1
    AND (last_sync IS NULL OR last_sync < datetime('now', ?))`, `-${Number(hours) || 24} hours`).map((r) => r.id);
  return { syncConnector, dueConnectors };
};
