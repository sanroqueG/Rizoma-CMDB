'use strict';
/*
 * Integração com RMM (NinjaOne): uma ligação por organização; cada "organização" do NinjaOne
 * corresponde a um cliente do Rizoma (associação feita pelo administrador, com sugestão pelo nome).
 * Os dispositivos entram pelo reconciliador comum (sem duplicar o que já veio dos agentes ou do Intune).
 */
const { fail } = require('../http');
const S = require('../schema');
const { createNinjaOne, deviceToAsset, REGIONS } = require('../rmm/ninjaone');

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\b(lda|sa|unipessoal|ltd|inc|gmbh|sl)\b\.?/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

module.exports = function registerRmm(core) {
  const { add, one, all, run, tx, audit, assertAdmin, box, fetchFn, reconciler, state } = core;

  const conn = (orgId) => one('SELECT * FROM rmm_connections WHERE org_id = ?', orgId);
  const view = (c) => {
    if (!c) return { configured: false, regions: Object.keys(REGIONS) };
    const map = all(`SELECT m.remote_org_id, m.remote_org_name, m.client_id, cl.name AS client_name, m.devices
      FROM rmm_client_map m LEFT JOIN clients cl ON cl.id = m.client_id WHERE m.connection_id = ? ORDER BY m.remote_org_name`, c.id);
    return {
      configured: true, regions: Object.keys(REGIONS), provider: c.provider, region: c.region, client_id: c.api_client_id,
      enabled: !!c.enabled, last_sync: c.last_sync, last_status: c.last_status, last_report: c.last_report ? JSON.parse(c.last_report) : null,
      mapping: map,
    };
  };
  const api = (c) => {
    let secret;
    try { secret = box.open(c.secret_enc); } catch { fail(400, 'Não foi possível desencriptar o segredo. Volte a guardá-lo.'); }
    return createNinjaOne({ region: c.region, clientId: c.api_client_id, secret, fetchFn });
  };

  /** Atualiza a lista de organizações do NinjaOne e sugere o cliente pelo nome (só quando ainda não há associação). */
  async function refreshOrgs(c) {
    const remote = await api(c).organizations();
    const clients = all('SELECT id, name, code FROM clients WHERE org_id = ?', c.org_id);
    const guess = (name) => {
      const n = norm(name);
      return clients.find((cl) => norm(cl.name) === n || norm(cl.code) === n)?.id ?? null;
    };
    tx(() => {
      for (const o of remote) {
        const prev = one('SELECT * FROM rmm_client_map WHERE connection_id = ? AND remote_org_id = ?', c.id, String(o.id));
        if (prev) run('UPDATE rmm_client_map SET remote_org_name = ? WHERE connection_id = ? AND remote_org_id = ?', o.name, c.id, String(o.id));
        else run('INSERT INTO rmm_client_map (connection_id, remote_org_id, remote_org_name, client_id) VALUES (?,?,?,?)', c.id, String(o.id), o.name, guess(o.name));
      }
      const ids = new Set(remote.map((o) => String(o.id)));
      for (const m of all('SELECT remote_org_id FROM rmm_client_map WHERE connection_id = ?', c.id)) {
        if (!ids.has(m.remote_org_id)) run('DELETE FROM rmm_client_map WHERE connection_id = ? AND remote_org_id = ?', c.id, m.remote_org_id);
      }
    });
    return remote.length;
  }

  /** Sincroniza os dispositivos de todas as organizações associadas. */
  async function syncRmm(connectionId, actor) {
    const c = one('SELECT * FROM rmm_connections WHERE id = ?', connectionId);
    if (!c) fail(404, 'Integração não configurada');
    if (!state.locks.acquire(`rmm:${c.id}`, 15 * 60e3)) fail(409, 'Já existe uma sincronização em curso');
    const report = { clientes: {}, sem_cliente: 0, erros: [] };
    try {
      try {
        await refreshOrgs(c);
        const devices = await api(c).devices();
        const map = new Map(all('SELECT remote_org_id, client_id FROM rmm_client_map WHERE connection_id = ?', c.id).map((m) => [m.remote_org_id, m.client_id]));
        const byClient = new Map();
        const perRemote = new Map();
        for (const d of devices) {
          const rid = String(d.organizationId);
          perRemote.set(rid, (perRemote.get(rid) || 0) + 1);
          const clientId = map.get(rid);
          if (!clientId) { report.sem_cliente++; continue; }
          if (!byClient.has(clientId)) byClient.set(clientId, []);
          byClient.get(clientId).push(d);
        }
        for (const [rid, n] of perRemote) run('UPDATE rmm_client_map SET devices = ? WHERE connection_id = ? AND remote_org_id = ?', n, c.id, rid);
        for (const [clientId, list] of byClient) {
          const name = one('SELECT name FROM clients WHERE id = ? AND org_id = ?', clientId, c.org_id)?.name;
          if (!name) continue; // cliente de outra organização ou eliminado: ignorar
          const cnt = { created: 0, updated: 0, unchanged: 0, retired: 0, erros: 0 };
          tx(() => {
            const seen = [];
            for (const d of list) {
              const a = deviceToAsset(d);
              seen.push(a.external_id);
              try {
                cnt[reconciler.upsert(clientId, a, 'ninjaone', 'ninjaone', { owns: true, lastSeen: a.lastSeen }).action]++;
              } catch (e) {
                cnt.erros++;
                if (report.erros.length < 20) report.erros.push(`${a.name || d.id}: ${e.message}`);
              }
            }
            cnt.retired = reconciler.retireMissing(clientId, 'ninjaone:', seen, 'ninjaone');
          });
          report.clientes[name] = cnt;
        }
      } catch (e) {
        report.erros.push(e.message);
      }
      const hasData = Object.keys(report.clientes).length > 0;
      const status = !report.erros.length ? 'ok' : hasData ? 'parcial' : 'erro';
      run("UPDATE rmm_connections SET last_sync = datetime('now'), last_status = ?, last_report = ? WHERE id = ?", status, JSON.stringify(report), c.id);
      audit('connector', c.id, null, 'NinjaOne', actor, 'sync', { estado: status, clientes: Object.keys(report.clientes).length }, c.org_id);
      return { status, report };
    } finally {
      state.locks.release(`rmm:${c.id}`);
    }
  }
  core.syncRmm = syncRmm;
  core.dueRmm = (hours) => all(`SELECT id FROM rmm_connections WHERE enabled = 1
    AND (last_sync IS NULL OR last_sync < datetime('now', ?))`, `-${Number(hours) || 24} hours`).map((r) => r.id);

  // ------------------------------------------------------------ rotas (administrador)
  add('GET', '/api/rmm', ({ user }) => { assertAdmin(user); return view(conn(user.org_id)); });

  add('PUT', '/api/rmm', async ({ user, body }) => {
    assertAdmin(user);
    const prev = conn(user.org_id);
    if (!prev && !body.secret) fail(400, 'O client secret é obrigatório');
    const secret = body.secret ? box.seal(body.secret) : prev.secret_enc;
    run(`INSERT INTO rmm_connections (org_id, provider, region, api_client_id, secret_enc, enabled) VALUES (?, 'ninjaone', ?, ?, ?, ?)
      ON CONFLICT(org_id) DO UPDATE SET region = excluded.region, api_client_id = excluded.api_client_id, secret_enc = excluded.secret_enc, enabled = excluded.enabled`,
    user.org_id, body.region, body.client_id, secret, body.enabled === false ? 0 : 1);
    const c = conn(user.org_id);
    audit('connector', c.id, null, 'NinjaOne', user.username, prev ? 'update' : 'create',
      { regiao: body.region, ativo: body.enabled !== false, segredo: body.secret ? '(alterado)' : undefined }, user.org_id);
    // Valida já as credenciais e traz a lista de organizações do NinjaOne
    let error = null;
    try { await refreshOrgs(c); } catch (e) { error = e.message; }
    return { ...view(conn(user.org_id)), test_error: error };
  }, {
    body: S.obj({
      region: S.str({ enum: Object.keys(REGIONS), required: true, label: 'Região' }),
      client_id: S.str({ max: 200, required: true, label: 'Client ID' }),
      secret: S.str({ max: 500, truncate: false }),
      enabled: S.bool(),
    }),
  });

  add('PUT', '/api/rmm/mapping', ({ user, body }) => {
    assertAdmin(user);
    const c = conn(user.org_id);
    if (!c) fail(404, 'Integração não configurada');
    tx(() => {
      for (const m of body.items) {
        if (m.client_id && !one('SELECT 1 FROM clients WHERE id = ? AND org_id = ?', m.client_id, user.org_id)) fail(400, 'Cliente inválido');
        run('UPDATE rmm_client_map SET client_id = ? WHERE connection_id = ? AND remote_org_id = ?', m.client_id || null, c.id, String(m.remote_org_id));
      }
    });
    audit('connector', c.id, null, 'NinjaOne', user.username, 'update', { associacoes: body.items.length }, user.org_id);
    return view(conn(user.org_id));
  }, {
    body: S.obj({
      items: S.arr(S.obj({ remote_org_id: S.str({ max: 60, required: true }), client_id: S.int({ minimum: 1 }) }), { maxItems: 5000, required: true }),
    }),
  });

  add('POST', '/api/rmm/sync', async ({ user }) => {
    assertAdmin(user);
    const c = conn(user.org_id);
    if (!c) fail(404, 'Integração não configurada');
    return syncRmm(c.id, user.username);
  });

  add('DELETE', '/api/rmm', ({ user }) => {
    assertAdmin(user);
    const c = conn(user.org_id);
    if (!c) fail(404, 'Integração não configurada');
    run('DELETE FROM rmm_connections WHERE id = ?', c.id);
    audit('connector', c.id, null, 'NinjaOne', user.username, 'delete', null, user.org_id);
    return { ok: true };
  });
};
