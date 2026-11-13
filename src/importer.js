'use strict';
/* Importação de ativos a partir de linhas tabulares (CSV/XLSX lidos no browser ou enviados por API).
   Aceita cabeçalhos em português ou inglês e o próprio CSV exportado pelo Rizoma. */

const norm = (v) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

const HEADER_MAP = {
  nome: 'name', name: 'name', designacao: 'name', ativo: 'name',
  tipo: 'type', type: 'type', typename: 'type', tipodeativo: 'type',
  estado: 'status', status: 'status',
  criticidade: 'criticality', criticality: 'criticality',
  ambiente: 'environment', environment: 'environment',
  local: 'site', site: 'site', sitename: 'site', localizacao: 'site',
  hostname: 'hostname', host: 'hostname', nomedamaquina: 'hostname', computername: 'hostname',
  ip: 'ip_address', ipaddress: 'ip_address', enderecoip: 'ip_address', enderecoipv4: 'ip_address',
  numerodeserie: 'serial_number', ndeserie: 'serial_number', nserie: 'serial_number', nodeserie: 'serial_number',
  serie: 'serial_number', serial: 'serial_number', serialnumber: 'serial_number', sn: 'serial_number',
  etiqueta: 'asset_tag', etiquetadeinventario: 'asset_tag', assettag: 'asset_tag', ninventario: 'asset_tag', inventario: 'asset_tag',
  fabricante: 'manufacturer', manufacturer: 'manufacturer', marca: 'manufacturer', vendor: 'manufacturer',
  modelo: 'model', model: 'model',
  sistemaoperativo: 'os', so: 'os', os: 'os', operatingsystem: 'os',
  responsavel: 'owner', owner: 'owner', utilizador: 'owner', user: 'owner',
  datadecompra: 'purchase_date', purchasedate: 'purchase_date', dataaquisicao: 'purchase_date', datadeaquisicao: 'purchase_date',
  fimdegarantia: 'warranty_end', garantia: 'warranty_end', garantiaate: 'warranty_end', warrantyend: 'warranty_end', warranty: 'warranty_end',
  notas: 'notes', notes: 'notes', observacoes: 'notes', obs: 'notes',
  // colunas do CSV exportado que são ignoradas
  id: null, clientname: null, cliente: null, client: null, source: null, origem: null, lastseen: null, updatedat: null,
};

const STATUS_MAP = {
  planeado: 'planeado', planned: 'planeado',
  emstock: 'em_stock', stock: 'em_stock', instock: 'em_stock', armazem: 'em_stock',
  emproducao: 'em_producao', producao: 'em_producao', ativo: 'em_producao', active: 'em_producao', inproduction: 'em_producao', inuse: 'em_producao', emuso: 'em_producao',
  emmanutencao: 'em_manutencao', manutencao: 'em_manutencao', maintenance: 'em_manutencao', reparacao: 'em_manutencao',
  abatido: 'abatido', retired: 'abatido', disposed: 'abatido', inativo: 'abatido', inactive: 'abatido',
};
const CRIT_MAP = { baixa: 'baixa', low: 'baixa', media: 'media', medium: 'media', normal: 'media', alta: 'alta', high: 'alta', critica: 'critica', critical: 'critica' };
const ENV_MAP = {
  producao: 'producao', production: 'producao', prod: 'producao', prd: 'producao',
  qualidade: 'qualidade', qa: 'qualidade', teste: 'qualidade', testes: 'qualidade', test: 'qualidade', staging: 'qualidade',
  desenvolvimento: 'desenvolvimento', dev: 'desenvolvimento', development: 'desenvolvimento',
};

/** AAAA-MM-DD a partir de vários formatos (incluindo nº de série de data do Excel). */
function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const t = String(v).trim();
  let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t))) return ymd(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t))) return ymd(+m[3], +m[2], +m[1]);
  if (/^\d{4,5}(\.\d+)?$/.test(t)) {
    const n = Math.floor(Number(t));
    if (n > 20000 && n < 80000) return new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);
  }
  throw new Error(`data inválida "${t}" (use AAAA-MM-DD ou DD/MM/AAAA)`);
}
function ymd(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) throw new Error(`data inexistente ${d}/${mo}/${y}`);
  return dt.toISOString().slice(0, 10);
}

function createImporter({ one, all, run, audit, readCiInput }) {
  function mapColumns(headers) {
    const map = {};
    for (const h of headers) {
      const k = norm(h);
      if (!k) continue;
      map[h] = k in HEADER_MAP ? HEADER_MAP[k] : 'attributes';
    }
    return map;
  }

  /**
   * @returns {{ dry_run: boolean, columns: any, summary: any, results: any[] }}
   * As escritas correm numa transação; em dry_run a transação é anulada no fim.
   */
  function importRows(user, clientId, rows, { dryRun = true, update = true, createSites = true } = {}) {
    if (!Array.isArray(rows) || !rows.length) throw Object.assign(new Error('Sem linhas para importar'), { status: 400 });
    if (rows.length > 5000) throw Object.assign(new Error('Máximo de 5000 linhas por importação'), { status: 400 });

    const headers = [...new Set(rows.flatMap((r) => Object.keys(r || {})))];
    const columns = mapColumns(headers);
    if (!Object.values(columns).includes('name') && !Object.values(columns).includes('hostname')) {
      throw Object.assign(new Error('O ficheiro precisa de uma coluna "Nome" (ou "Hostname")'), { status: 400 });
    }
    const types = all('SELECT id, name FROM ci_types WHERE org_id IS NULL OR org_id = (SELECT org_id FROM clients WHERE id = ?)', clientId);
    const typeByNorm = new Map(types.map((t) => [norm(t.name), t.id]));
    const siteCache = new Map(all('SELECT id, name FROM sites WHERE client_id = ?', clientId).map((s) => [norm(s.name), s.id]));
    const defaultType = typeByNorm.get(norm('Posto de trabalho'));
    const actor = user.username;
    const results = [];
    const summary = { created: 0, updated: 0, unchanged: 0, errors: 0, sites_created: 0 };

    db_begin();
    try {
      rows.forEach((raw, i) => {
        const rowNo = i + 2; // linha 1 = cabeçalho
        try {
          const f = {};
          const attrs = {};
          for (const [h, val] of Object.entries(raw || {})) {
            const target = columns[h];
            if (target === undefined || target === null) continue;
            const v = val === null || val === undefined ? '' : String(val).trim();
            if (v === '') continue;
            if (target === 'attributes') attrs[String(h).trim().slice(0, 64)] = v;
            else f[target] = v;
          }
          if (!f.name && f.hostname) f.name = f.hostname;
          if (!f.name) {
            if (!Object.keys(f).length && !Object.keys(attrs).length) return; // linha vazia
            throw new Error('nome em falta');
          }

          const body = {};
          for (const k of ['name', 'hostname', 'ip_address', 'serial_number', 'asset_tag', 'manufacturer', 'model', 'os', 'owner', 'notes']) {
            if (f[k] !== undefined) body[k] = f[k];
          }
          if (f.type) {
            const t = typeByNorm.get(norm(f.type));
            if (!t) throw new Error(`tipo desconhecido "${f.type}"`);
            body.type_id = t;
          }
          if (f.status) {
            body.status = STATUS_MAP[norm(f.status)];
            if (!body.status) throw new Error(`estado desconhecido "${f.status}"`);
          }
          if (f.criticality) {
            body.criticality = CRIT_MAP[norm(f.criticality)];
            if (!body.criticality) throw new Error(`criticidade desconhecida "${f.criticality}"`);
          }
          if (f.environment) {
            body.environment = ENV_MAP[norm(f.environment)];
            if (!body.environment) throw new Error(`ambiente desconhecido "${f.environment}"`);
          }
          if (f.purchase_date) body.purchase_date = parseDate(f.purchase_date);
          if (f.warranty_end) body.warranty_end = parseDate(f.warranty_end);
          let siteName = null;
          if (f.site) {
            const key = norm(f.site);
            if (siteCache.has(key)) body.site_id = siteCache.get(key);
            else if (createSites) siteName = f.site.slice(0, 120);
            else throw new Error(`local desconhecido "${f.site}"`);
          }
          const d = readCiInput(body); // validação comum (tamanhos, formatos)

          // Procurar existente: nº série → hostname → nome+tipo
          let existing = null;
          if (update) {
            if (d.serial_number) existing = one('SELECT * FROM cis WHERE client_id = ? AND serial_number = ? ORDER BY id LIMIT 1', clientId, d.serial_number);
            if (!existing && d.hostname) existing = one('SELECT * FROM cis WHERE client_id = ? AND hostname = ? COLLATE NOCASE ORDER BY id LIMIT 1', clientId, d.hostname);
            if (!existing) {
              existing = d.type_id
                ? one('SELECT * FROM cis WHERE client_id = ? AND name = ? COLLATE NOCASE AND type_id = ? ORDER BY id LIMIT 1', clientId, d.name, d.type_id)
                : one('SELECT * FROM cis WHERE client_id = ? AND name = ? COLLATE NOCASE ORDER BY id LIMIT 1', clientId, d.name);
            }
          }

          if (siteName) {
            const r = run('INSERT INTO sites (client_id, name) VALUES (?, ?)', clientId, siteName);
            const sid = Number(r.lastInsertRowid);
            siteCache.set(norm(siteName), sid);
            audit('site', sid, clientId, siteName, actor, 'create', { origem: 'importação' });
            d.site_id = sid;
            summary.sites_created++;
          }

          if (existing) {
            const merged = JSON.stringify({ ...JSON.parse(existing.attributes || '{}'), ...attrs });
            if (merged !== existing.attributes) d.attributes = merged;
            const changes = {};
            for (const [k, v] of Object.entries(d)) if (v !== null && (existing[k] ?? null) !== v) changes[k] = [existing[k] ?? null, v];
            if (!Object.keys(changes).length) {
              summary.unchanged++;
              results.push({ row: rowNo, action: 'unchanged', id: existing.id, name: existing.name });
              return;
            }
            const cols = Object.keys(changes);
            run(`UPDATE cis SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...cols.map((k) => d[k]), existing.id);
            if (changes.attributes) changes.attributes = ['…', '(atualizados)'];
            audit('ci', existing.id, clientId, d.name || existing.name, actor, 'update', { ...changes, origem: 'importação' });
            summary.updated++;
            results.push({ row: rowNo, action: 'updated', id: existing.id, name: d.name || existing.name });
            return;
          }

          d.client_id = clientId;
          d.type_id = d.type_id || defaultType;
          d.source = 'import';
          d.attributes = JSON.stringify(attrs);
          const cols = Object.keys(d).filter((k) => d[k] !== undefined);
          const r = run(`INSERT INTO cis (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((k) => d[k]));
          const id = Number(r.lastInsertRowid);
          audit('ci', id, clientId, d.name, actor, 'create', { origem: 'importação' });
          summary.created++;
          results.push({ row: rowNo, action: 'created', id, name: d.name });
        } catch (e) {
          summary.errors++;
          results.push({ row: rowNo, action: 'error', name: raw && (raw.Nome || raw.nome || raw.name || raw.Name) || null, error: e.message });
        }
      });
      if (dryRun) db_rollback(); else db_commit();
    } catch (e) {
      db_rollback();
      throw e;
    }
    return { dry_run: dryRun, columns, summary, results };
  }

  // Transações explícitas (o importador é síncrono, não há concorrência dentro do processo)
  let db_begin = () => run('BEGIN');
  let db_commit = () => run('COMMIT');
  let db_rollback = () => { try { run('ROLLBACK'); } catch { /* sem transação ativa */ } };

  return { importRows, mapColumns };
}

module.exports = { createImporter, parseDate, norm };
