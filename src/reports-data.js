'use strict';
/* Dados do relatório por cliente e geração do Excel. Funções puras sobre o store: correm na thread principal ou numa worker. */
const { buildXlsx } = require('./xlsx');

const L = {
  status: { planeado: 'Planeado', em_stock: 'Em stock', em_producao: 'Em produção', em_manutencao: 'Em manutenção', abatido: 'Abatido' },
  crit: { baixa: 'Baixa', media: 'Média', alta: 'Alta', critica: 'Crítica' },
  env: { producao: 'Produção', qualidade: 'Qualidade', desenvolvimento: 'Desenvolvimento' },
  source: { manual: 'Manual', agent: 'Agente', import: 'Importação', intune: 'Intune', azure: 'Azure', m365: 'Microsoft 365' },
  kind: { licenca: 'Licença', suporte: 'Suporte', manutencao: 'Manutenção', subscricao: 'Subscrição', garantia: 'Garantia', outsourcing: 'Outsourcing', outro: 'Outro' },
  cstatus: { ativo: 'Ativo', terminado: 'Terminado', cancelado: 'Cancelado' },
  billing: { mensal: 'Mensal', trimestral: 'Trimestral', anual: 'Anual', unico: 'Pagamento único' },
  rel: { depende_de: 'depende de', corre_em: 'corre em', alojado_em: 'está alojado em', ligado_a: 'está ligado a', usa: 'usa' },
};
const PER_YEAR = { mensal: 12, trimestral: 4, anual: 1 };
const annual = (c) => (c.cost !== null && PER_YEAR[c.billing] ? Math.round(c.cost * PER_YEAR[c.billing] * 100) / 100 : null);

/** Reúne os dados do relatório de um cliente (o acesso já foi verificado). q = { one, all }. */
function collectReport({ one, all }, c) {
  const cis = all(`SELECT c.*, t.name AS type_name, s.name AS site_name FROM cis c JOIN ci_types t ON t.id = c.type_id
    LEFT JOIN sites s ON s.id = c.site_id WHERE c.client_id = ? ORDER BY t.name, c.name`, c.id);
  const contracts = all('SELECT * FROM contracts WHERE client_id = ? ORDER BY status, (end_date IS NULL), end_date, name', c.id)
    .map((k) => ({ ...k, annual_cost: annual(k) }));
  const relationships = all(`SELECT r.type, a.name AS source, b.name AS target FROM relationships r
    JOIN cis a ON a.id = r.source_id JOIN cis b ON b.id = r.target_id WHERE a.client_id = ? ORDER BY a.name, b.name`, c.id);
  const sites = all(`SELECT s.name, s.address, (SELECT COUNT(*) FROM cis WHERE site_id = s.id) AS ci_count
    FROM sites s WHERE s.client_id = ? ORDER BY s.name`, c.id);
  const active = cis.filter((x) => x.status !== 'abatido');
  const count = (list, key) => Object.entries(list.reduce((m, x) => { m[x[key]] = (m[x[key]] || 0) + 1; return m; }, {}))
    .map(([k, n]) => ({ key: k, n })).sort((a, b) => b.n - a.n);
  const warranties = active.filter((x) => x.warranty_end && x.warranty_end <= one("SELECT date('now', '+180 days') AS d").d)
    .sort((a, b) => a.warranty_end.localeCompare(b.warranty_end));
  const renewals = contracts.filter((k) => k.status === 'ativo' && k.end_date && k.end_date <= one("SELECT date('now', '+180 days') AS d").d);
  const tickets = all(`SELECT t.* FROM tickets t WHERE t.client_id = ? AND t.closed = 0 ORDER BY t.updated_at DESC LIMIT 200`, c.id);
  return {
    client: { id: c.id, name: c.name, code: c.code, contact_name: c.contact_name, contact_email: c.contact_email },
    generated_at: new Date().toISOString(),
    totals: {
      cis: cis.length, active: active.length, critical: active.filter((x) => x.criticality === 'critica').length,
      agents: active.filter((x) => x.source === 'agent').length, sites: sites.length,
      contracts: contracts.filter((k) => k.status === 'ativo').length,
      annual_cost: Math.round(contracts.filter((k) => k.status === 'ativo').reduce((s, k) => s + (k.annual_cost || 0), 0) * 100) / 100,
      open_tickets: tickets.length,
    },
    byType: count(active, 'type_name'), byStatus: count(cis, 'status'), byCriticality: count(active, 'criticality'),
    sites, warranties, renewals, contracts, relationships, tickets, cis,
  };
}

/** Excel (.xlsx) do relatório; devolve um Buffer. */
function buildReportXlsx(q, c) {
  const r = collectReport(q, c);
  const t = r.totals;
  return buildXlsx([
    {
      name: 'Resumo', headers: ['Indicador', 'Valor'], widths: [42, 40],
      rows: [
        ['Cliente', `${c.name} (${c.code})`], ['Contacto', [c.contact_name, c.contact_email].filter(Boolean).join(' · ')],
        ['Gerado em', r.generated_at.slice(0, 16).replace('T', ' ') + ' UTC'], [],
        ['Ativos (total)', t.cis], ['Ativos em uso (não abatidos)', t.active], ['Ativos de criticidade crítica', t.critical],
        ['Ativos com agente de inventário', t.agents], ['Locais', t.sites], ['Contratos ativos', t.contracts],
        ['Custo anual dos contratos (€)', t.annual_cost], ['Incidentes abertos', t.open_tickets],
        ['Garantias expiradas ou a expirar em 180 dias', r.warranties.length], ['Renovações nos próximos 180 dias', r.renewals.length],
        [], ['Ativos por tipo', ''], ...r.byType.map((x) => [`  ${x.key}`, x.n]),
        [], ['Ativos por estado', ''], ...r.byStatus.map((x) => [`  ${L.status[x.key] || x.key}`, x.n]),
      ],
    },
    {
      name: 'Ativos',
      headers: ['ID', 'Nome', 'Tipo', 'Estado', 'Criticidade', 'Ambiente', 'Local', 'Hostname', 'IP', 'Nº de série', 'Etiqueta',
        'Fabricante', 'Modelo', 'Sistema operativo', 'Responsável', 'Data de compra', 'Fim de garantia', 'Origem', 'Último contacto'],
      rows: r.cis.map((x) => [x.id, x.name, x.type_name, L.status[x.status] || x.status, L.crit[x.criticality] || x.criticality,
        L.env[x.environment] || x.environment, x.site_name, x.hostname, x.ip_address, x.serial_number, x.asset_tag, x.manufacturer,
        x.model, x.os, x.owner, x.purchase_date, x.warranty_end, L.source[x.source] || x.source, x.last_seen]),
    },
    {
      name: 'Contratos',
      headers: ['Nome', 'Tipo', 'Fornecedor', 'Referência', 'Estado', 'Início', 'Fim', 'Renovação automática', 'Pré-aviso (dias)',
        'Quantidade', 'Custo (€)', 'Periodicidade', 'Custo anual (€)', 'Responsável'],
      rows: r.contracts.map((k) => [k.name, L.kind[k.kind] || k.kind, k.vendor, k.reference, L.cstatus[k.status] || k.status,
        k.start_date, k.end_date, k.auto_renew ? 'Sim' : 'Não', k.notice_days, k.quantity, k.cost, L.billing[k.billing] || k.billing,
        k.annual_cost, k.owner]),
    },
    {
      name: 'Garantias e renovações',
      headers: ['Tipo', 'Nome', 'Data', 'Situação'],
      rows: [
        ...r.warranties.map((x) => ['Garantia', x.name, x.warranty_end, x.warranty_end < r.generated_at.slice(0, 10) ? 'Expirada' : 'A expirar']),
        ...r.renewals.map((k) => ['Contrato', k.name, k.end_date, k.auto_renew ? 'Renovação automática' : 'Renovar']),
      ],
    },
    {
      name: 'Relações', headers: ['Origem', 'Relação', 'Destino'],
      rows: r.relationships.map((x) => [x.source, L.rel[x.type] || x.type, x.target]),
    },
  ]);
}

module.exports = { collectReport, buildReportXlsx };
