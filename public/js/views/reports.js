/* Relatório por cliente: página imprimível (Imprimir → Guardar como PDF) e exportação Excel. */
import { BRAND, GET, L, badge, brandMark, card, dash, daysUntil, fmtDate, fmtMoney, h, icon, table, todayIso } from '../core.js';
import { pageHead, setPage } from '../main.js';
import { contractCost, contractEndBadge } from './contracts.js';

export async function viewClientReport(id) {
  const r = await GET(`/api/clients/${id}/report`);
  const t = r.totals;
  const today = todayIso();
  const kpi = (label, value) => h('div', { class: 'col-6 col-md-3' }, h('div', { class: 'card card-sm' }, h('div', { class: 'card-body' },
    h('div', { class: 'subheader' }, label), h('div', { class: 'h1 mb-0 mt-1' }, value))));
  const countTable = (rows, labels, head) => table([head, { label: 'Ativos', cls: 'num' }],
    rows.map((x) => h('tr', {}, h('td', {}, labels ? labels[x.key] || x.key : x.key), h('td', { class: 'text-end' }, x.n))), 'Sem ativos.');

  setPage(
    pageHead({ title: 'Relatório', crumbs: [['Clientes', '#/clientes'], [r.client.name, `#/clientes/${id}`]] },
      'Use "Imprimir" e escolha "Guardar como PDF" para enviar ao cliente.',
      h('a', { class: 'btn', href: `/api/clients/${id}/report.xlsx`, download: '' }, icon('download'), 'Exportar Excel'),
      h('button', { class: 'primary', onclick: () => window.print() }, icon('printer'), 'Imprimir / PDF')),
    h('div', { class: 'report d-flex flex-column gap-3' },
      h('div', { class: 'card' }, h('div', { class: 'card-body d-flex align-items-center gap-3 flex-wrap' },
        brandMark(40),
        h('div', { class: 'flex-fill' }, h('div', { class: 'subheader' }, 'Relatório de inventário'), h('h2', { class: 'h1 m-0' }, r.client.name),
          h('div', { class: 'text-secondary' }, [r.client.code, r.client.contact_name, r.client.contact_email].filter(Boolean).join(' · '))),
        h('div', { class: 'text-secondary text-end' }, new Date(r.generated_at).toLocaleString('pt-PT', { dateStyle: 'long', timeStyle: 'short' })))),
      h('div', { class: 'row row-cards' },
        kpi('Ativos em uso', t.active), kpi('Críticos', t.critical), kpi('Contratos ativos', t.contracts), kpi('Custo anual', fmtMoney(t.annual_cost))),
      h('div', { class: 'row row-cards' },
        h('div', { class: 'col-md-6' }, card('Ativos por tipo', countTable(r.byType, null, 'Tipo'))),
        h('div', { class: 'col-md-6' }, card('Ativos por estado', countTable(r.byStatus, L.status, 'Estado')))),
      card(`Garantias expiradas ou a expirar em 180 dias · ${r.warranties.length}`,
        table(['Ativo', 'Tipo', 'Nº de série', 'Fim de garantia', 'Situação'], r.warranties.map((c) => h('tr', {},
          h('td', {}, c.name), h('td', { class: 'text-secondary' }, c.type_name), h('td', { class: 'font-monospace small' }, dash(c.serial_number)),
          h('td', {}, fmtDate(c.warranty_end)),
          h('td', {}, c.warranty_end < today ? badge('Expirada', 'danger') : badge(`Em ${daysUntil(c.warranty_end)} dias`, 'warn')))), 'Nenhuma garantia a expirar.'), { cls: 'report-section' }),
      card(`Contratos · ${r.contracts.length}`,
        table(['Contrato', 'Tipo', 'Fornecedor', 'Fim', 'Situação', { label: 'Custo anual', cls: 'num' }], r.contracts.map((k) => h('tr', {},
          h('td', {}, k.name), h('td', { class: 'text-secondary' }, L.kind[k.kind] || k.kind), h('td', {}, dash(k.vendor)),
          h('td', {}, k.end_date ? fmtDate(k.end_date) : '—'), h('td', {}, contractEndBadge(k)),
          h('td', { class: 'text-end' }, k.annual_cost !== null ? fmtMoney(k.annual_cost) : contractCost(k)))), 'Sem contratos registados.'), { cls: 'report-section' }),
      r.tickets.length ? card(`Incidentes abertos · ${r.tickets.length}`,
        table(['Sistema', 'Ticket', 'Título', 'Estado', 'Atualizado'], r.tickets.map((x) => h('tr', {},
          h('td', {}, x.system), h('td', {}, x.external_id), h('td', {}, dash(x.title)), h('td', {}, dash(x.status)),
          h('td', { class: 'text-secondary' }, fmtDate(x.updated_at))))), { cls: 'report-section' }) : null,
      card(`Locais · ${r.sites.length}`,
        table(['Local', 'Morada', { label: 'Ativos', cls: 'num' }], r.sites.map((s) => h('tr', {},
          h('td', {}, s.name), h('td', { class: 'text-secondary' }, dash(s.address)), h('td', { class: 'text-end' }, s.ci_count))), 'Sem locais.'), { cls: 'report-section' }),
      card(`Inventário completo · ${r.cis.length}`,
        table(['Nome', 'Tipo', 'Estado', 'Local', 'Fabricante / modelo', 'Nº de série', 'Responsável'], r.cis.map((c) => h('tr', {},
          h('td', {}, c.name), h('td', { class: 'text-secondary' }, c.type_name), h('td', {}, L.status[c.status] || c.status), h('td', {}, dash(c.site_name)),
          h('td', {}, [c.manufacturer, c.model].filter(Boolean).join(' ') || '—'), h('td', { class: 'font-monospace small' }, dash(c.serial_number)),
          h('td', {}, dash(c.owner)))), 'Sem ativos.'), { cls: 'report-section' }),
      h('p', { class: 'text-secondary small' }, `${r.relationship_count} relação(ões) entre ativos registadas. Relatório gerado pelo ${BRAND}.`)));
}
