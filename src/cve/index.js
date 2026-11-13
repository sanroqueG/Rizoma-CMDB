'use strict';
/*
 * Inventário de software e vulnerabilidades conhecidas (CVE).
 *
 * - O agente envia o software instalado; os nomes conhecidos do catálogo (src/cve/catalog.js) ganham um produto CPE.
 * - Por produto, a lista de CVE vem da API 2.0 da NVD (com os intervalos de versões afetadas), em cache 24 h.
 *   Sem chave: 5 pedidos por 30 s (espera de 6 s entre pedidos); com CMDB_NVD_API_KEY: 50 por 30 s.
 * - A lista KEV da CISA marca as vulnerabilidades já exploradas por atacantes.
 * - ci_vulns guarda as correspondências (ativo × CVE), com a data em que apareceram (avisos de novidades).
 */
const { productFor, inRange } = require('./catalog');

const NVD = 'https://services.nvd.nist.gov/rest/json/cves/2.0';
const KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
const STALE_MS = 24 * 3600e3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Extrai de um CVE da NVD o resumo e os intervalos vulneráveis do produto. */
function parseCve(item, product) {
  const c = item.cve || item;
  const m = c.metrics || {};
  const metric = (m.cvssMetricV40 || m.cvssMetricV31 || m.cvssMetricV30 || [])[0];
  const v2 = (m.cvssMetricV2 || [])[0];
  const score = metric ? metric.cvssData.baseScore : v2 ? v2.cvssData.baseScore : null;
  const severity = metric ? metric.cvssData.baseSeverity : v2 ? v2.baseSeverity : null;
  const prefix = `cpe:2.3:a:${product}:`;
  const ranges = [];
  for (const cfg of c.configurations || []) {
    for (const node of cfg.nodes || []) {
      if (node.negate) continue;
      for (const cm of node.cpeMatch || []) {
        if (!cm.vulnerable || !String(cm.criteria).startsWith(prefix)) continue;
        const v = String(cm.criteria).slice(prefix.length).split(':')[0];
        ranges.push({ v, si: cm.versionStartIncluding, se: cm.versionStartExcluding, ei: cm.versionEndIncluding, ee: cm.versionEndExcluding });
      }
    }
  }
  const summary = ((c.descriptions || []).find((d) => d.lang === 'en') || {}).value || '';
  return { id: c.id, score, severity: severity ? String(severity).toUpperCase() : null, summary: summary.slice(0, 500), published: (c.published || '').slice(0, 10), ranges };
}

/** @param {{ one: any, all: any, run: any, tx: any, fetchFn: any, log: any, opts?: any }} deps */
function createCve({ one, all, run, tx, fetchFn, log, opts = {} }) {
  const apiKey = opts.nvdApiKey ?? process.env.CMDB_NVD_API_KEY ?? '';
  const delayMs = opts.nvdDelayMs ?? (apiKey ? 700 : 6500);

  /** Substitui o software de um ativo e recalcula as vulnerabilidades dele. */
  function setSoftware(ciId, list) {
    const seen = new Map();
    for (const s of list.slice(0, 3000)) {
      const name = String(s.name || '').trim().slice(0, 255);
      if (!name) continue;
      const version = String(s.version || '').trim().slice(0, 100);
      seen.set(`${name}\u0000${version}`, { name, version, publisher: String(s.publisher || '').trim().slice(0, 255) || null, product: productFor(name) });
    }
    run('DELETE FROM ci_software WHERE ci_id = ?', ciId);
    for (const s of seen.values()) {
      run("INSERT INTO ci_software (ci_id, name, version, publisher, product, seen_at) VALUES (?,?,?,?,?, datetime('now'))", ciId, s.name, s.version, s.publisher, s.product);
    }
    rematchCi(ciId);
    return seen.size;
  }

  /** Recalcula as vulnerabilidades de um ativo a partir do software e da cache de CVE. */
  function rematchCi(ciId) {
    const found = new Map();
    for (const s of all('SELECT * FROM ci_software WHERE ci_id = ? AND product IS NOT NULL', ciId)) {
      for (const cve of all('SELECT id, ranges FROM cves WHERE product = ?', s.product)) {
        if (JSON.parse(cve.ranges).some((r) => inRange(s.version, r))) found.set(cve.id, s);
      }
    }
    const before = new Set(all('SELECT cve_id FROM ci_vulns WHERE ci_id = ?', ciId).map((r) => r.cve_id));
    for (const id of before) if (!found.has(id)) run('DELETE FROM ci_vulns WHERE ci_id = ? AND cve_id = ?', ciId, id);
    for (const [id, s] of found) {
      if (before.has(id)) run('UPDATE ci_vulns SET software = ?, version = ? WHERE ci_id = ? AND cve_id = ?', s.name, s.version, ciId, id);
      else run("INSERT INTO ci_vulns (ci_id, cve_id, software, version, first_seen) VALUES (?,?,?,?, strftime('%Y-%m-%d %H:%M:%f','now'))", ciId, id, s.name, s.version);
    }
    return found.size;
  }

  async function nvd(url) {
    const r = await fetchFn(url, { headers: apiKey ? { apiKey } : {} });
    if (!r.ok) throw new Error(`NVD ${r.status}`);
    return r.json();
  }

  /** Descarrega os CVE de um produto (todas as páginas) e guarda-os. */
  async function refreshProduct(product) {
    const list = [];
    let start = 0;
    for (let page = 0; page < 50; page++) {
      if (page) await sleep(delayMs);
      const data = await nvd(`${NVD}?virtualMatchString=${encodeURIComponent(`cpe:2.3:a:${product}`)}&noRejected&resultsPerPage=2000&startIndex=${start}`);
      for (const v of data.vulnerabilities || []) list.push(parseCve(v, product));
      start += data.resultsPerPage || 0;
      if (!data.resultsPerPage || start >= (data.totalResults || 0)) break;
    }
    tx(() => {
      run('DELETE FROM cves WHERE product = ?', product);
      for (const c of list) {
        if (!c.ranges.length) continue;
        run('INSERT OR REPLACE INTO cves (product, id, score, severity, summary, published, ranges) VALUES (?,?,?,?,?,?,?)',
          product, c.id, c.score, c.severity, c.summary, c.published, JSON.stringify(c.ranges));
      }
      run(`INSERT INTO cve_products (product, fetched_at, cve_count, error) VALUES (?, ?, ?, NULL)
        ON CONFLICT(product) DO UPDATE SET fetched_at = excluded.fetched_at, cve_count = excluded.cve_count, error = NULL`, product, Date.now(), list.length);
      for (const r of all('SELECT DISTINCT ci_id FROM ci_software WHERE product = ?', product)) rematchCi(r.ci_id);
    });
    return list.length;
  }

  async function refreshKev() {
    const k = one("SELECT value FROM settings WHERE key = 'cve:kev_at'");
    if (k && Date.now() - Number(k.value) < STALE_MS) return null;
    const r = await fetchFn(KEV_URL);
    if (!r.ok) throw new Error(`CISA KEV ${r.status}`);
    const data = await r.json();
    tx(() => {
      run('DELETE FROM kev');
      for (const v of data.vulnerabilities || []) {
        run('INSERT OR REPLACE INTO kev (cve_id, date_added, due_date, name) VALUES (?,?,?,?)', v.cveID, v.dateAdded, v.dueDate, String(v.vulnerabilityName || '').slice(0, 300));
      }
      run("INSERT INTO settings (key, value) VALUES ('cve:kev_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(Date.now()));
    });
    return (data.vulnerabilities || []).length;
  }

  /**
   * Atualiza os produtos em uso com cache antiga (no máximo maxProducts por execução) e a lista KEV.
   * Devolve { products, errors, newFindings: [{ org_id, org_name, client_id, client_name, cis, cves, kev }] }.
   */
  async function scan({ maxProducts = 40, now = Date.now() } = {}) {
    const due = all(`SELECT DISTINCT s.product FROM ci_software s LEFT JOIN cve_products p ON p.product = s.product
      WHERE s.product IS NOT NULL AND (p.fetched_at IS NULL OR p.fetched_at < ?) LIMIT ?`, now - STALE_MS, maxProducts).map((r) => r.product);
    const errors = [];
    for (let i = 0; i < due.length; i++) {
      if (i) await sleep(delayMs);
      try { await refreshProduct(due[i]); } catch (e) {
        errors.push(`${due[i]}: ${e.message}`);
        run(`INSERT INTO cve_products (product, fetched_at, error) VALUES (?, ?, ?)
          ON CONFLICT(product) DO UPDATE SET error = excluded.error`, due[i], null, e.message);
      }
    }
    try { await refreshKev(); } catch (e) { errors.push(e.message); }
    if (errors.length && log) log.error('Atualização de vulnerabilidades com erros', { erros: errors.slice(0, 5), err: new Error(errors[0]) });

    // Novidades desde a última vez (por cliente), para os avisos
    const last = one("SELECT value FROM settings WHERE key = 'cve:last_notice'")?.value || '1970-01-01';
    const stamp = one("SELECT strftime('%Y-%m-%d %H:%M:%f','now') AS t").t;
    const newFindings = all(`SELECT o.id AS org_id, o.name AS org_name, cl.id AS client_id, cl.name AS client_name,
        COUNT(DISTINCT v.ci_id) AS cis, COUNT(DISTINCT v.cve_id) AS cves, COUNT(DISTINCT k.cve_id) AS kev
      FROM ci_vulns v JOIN cis c ON c.id = v.ci_id JOIN clients cl ON cl.id = c.client_id JOIN organizations o ON o.id = cl.org_id
      LEFT JOIN kev k ON k.cve_id = v.cve_id
      WHERE v.first_seen > ? GROUP BY cl.id`, last);
    run("INSERT INTO settings (key, value) VALUES ('cve:last_notice', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", stamp);
    return { products: due.length, errors, newFindings };
  }

  return { setSoftware, rematchCi, refreshProduct, refreshKev, scan };
}

module.exports = { createCve, parseCve };
