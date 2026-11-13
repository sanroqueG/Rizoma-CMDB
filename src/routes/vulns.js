'use strict';
/* Software instalado e vulnerabilidades (CVE) por ativo e por cliente. Ver src/cve/index.js. */
const { fail, toId } = require('../http');
const { createCve } = require('../cve');

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

module.exports = function registerVulns(core) {
  const { add, one, all, run, tx, fetchFn, log, opts, getCi, scopeSql, assertPlatform } = core;
  const cve = createCve({ one, all, run, tx, fetchFn, log, opts });
  core.cve = cve;

  add('GET', '/api/cis/:id/software', ({ user, params }) => {
    const ci = getCi(user, params.id);
    return {
      software: all('SELECT name, version, publisher, product, seen_at FROM ci_software WHERE ci_id = ? ORDER BY name', ci.id),
      vulns: all(`SELECT v.cve_id, v.software, v.version, v.first_seen, c.score, c.severity, c.summary, c.published,
          k.date_added AS kev_added, k.due_date AS kev_due
        FROM ci_vulns v JOIN ci_software s ON s.ci_id = v.ci_id AND s.name = v.software AND s.version = v.version
        JOIN cves c ON c.id = v.cve_id AND c.product = s.product
        LEFT JOIN kev k ON k.cve_id = v.cve_id WHERE v.ci_id = ?
        ORDER BY (k.cve_id IS NOT NULL) DESC, c.score DESC, v.cve_id DESC`, ci.id),
    };
  });

  /** Vulnerabilidades nos ativos que o utilizador vê, agregadas por CVE. */
  add('GET', '/api/vulnerabilities', ({ user, query }) => {
    const sc = scopeSql(user, 'cl.id');
    const where = [sc.sql];
    const params = [...sc.params];
    if (query.client_id) { where.push('cl.id = ?'); params.push(toId(query.client_id, 'Cliente')); }
    if (query.severity) {
      if (!SEVERITIES.includes(query.severity)) fail(400, 'Gravidade inválida');
      where.push('c.severity = ?'); params.push(query.severity);
    }
    if (query.kev === '1') where.push('k.cve_id IS NOT NULL');
    const items = all(`SELECT v.cve_id, MAX(c.score) AS score, MAX(c.severity) AS severity, MAX(c.summary) AS summary, MAX(c.published) AS published,
        MAX(k.date_added) AS kev_added, COUNT(DISTINCT v.ci_id) AS cis, COUNT(DISTINCT cl.id) AS clients,
        GROUP_CONCAT(DISTINCT v.software) AS software, MIN(v.first_seen) AS first_seen
      FROM ci_vulns v JOIN cis ci ON ci.id = v.ci_id JOIN clients cl ON cl.id = ci.client_id
      JOIN ci_software s ON s.ci_id = v.ci_id AND s.name = v.software AND s.version = v.version
      JOIN cves c ON c.id = v.cve_id AND c.product = s.product
      LEFT JOIN kev k ON k.cve_id = v.cve_id
      WHERE ${where.join(' AND ')}
      GROUP BY v.cve_id ORDER BY (MAX(k.cve_id) IS NOT NULL) DESC, MAX(c.score) DESC, v.cve_id DESC LIMIT 500`, ...params);
    const totals = one(`SELECT COUNT(DISTINCT v.ci_id) AS cis, COUNT(DISTINCT v.cve_id) AS cves
      FROM ci_vulns v JOIN cis ci ON ci.id = v.ci_id JOIN clients cl ON cl.id = ci.client_id WHERE ${sc.sql}`, ...sc.params);
    const st = one('SELECT COUNT(*) AS products, MAX(fetched_at) AS last FROM cve_products WHERE fetched_at IS NOT NULL');
    const inventoried = one(`SELECT COUNT(DISTINCT s.ci_id) AS n FROM ci_software s JOIN cis ci ON ci.id = s.ci_id JOIN clients cl ON cl.id = ci.client_id WHERE ${sc.sql}`, ...sc.params).n;
    return {
      items, totals: { ...totals, inventoried },
      source: { products: st.products, last_update: st.last ? new Date(st.last).toISOString() : null, nvd_key: !!(opts.nvdApiKey ?? process.env.CMDB_NVD_API_KEY) },
    };
  });

  /** Plataforma: atualizar já (normalmente corre de hora a hora, com cache de 24 h por produto). */
  add('POST', '/api/vulnerabilities/scan', async ({ user }) => {
    assertPlatform(user);
    return core.runCveScan();
  });

  /** Atualiza a base de CVE e avisa as organizações das novidades (webhooks "vulnerability.detected"). */
  core.runCveScan = async (o) => {
    const r = await cve.scan(o);
    for (const f of r.newFindings) {
      core.webhooks.enqueue(f.org_id, 'vulnerability.detected', {
        organization: { id: f.org_id, name: f.org_name }, client: { id: f.client_id, name: f.client_name },
        entity: { type: 'client', id: f.client_id, label: f.client_name }, actor: null,
        data: { new_cves: f.cves, cis: f.cis, kev: f.kev }, url: core.webhooks.urlFor('client', f.client_id),
      });
    }
    return { products: r.products, errors: r.errors, notified: r.newFindings.length };
  };
};
