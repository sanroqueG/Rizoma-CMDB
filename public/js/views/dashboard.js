/* Dashboard. */
import { GET, L, ME, badge, card, fmtDate, fmtDateTime, h, icon, table } from '../core.js';
import { pageHead, setPage } from '../main.js';

// ======================================================================= dashboard
export async function viewDashboard() {
  const [d, renewals] = await Promise.all([GET('/api/dashboard'), GET('/api/contracts?expiring=60')]);
  const today = new Date().toISOString().slice(0, 10);
  const days = (s) => Math.round((Date.parse(s.slice(0, 10)) - Date.parse(today)) / 864e5);

  // Tudo o que exige ação, numa só lista
  const attention = [
    ...d.warranties.map((w) => {
      const late = w.warranty_end < today;
      return { href: `#/ativos/${w.id}`, name: w.name, client: w.client_name, late, why: late ? 'Garantia expirada' : 'Garantia a expirar',
        date: fmtDate(w.warranty_end), when: late ? `há ${-days(w.warranty_end)} d` : `em ${days(w.warranty_end)} d` };
    }),
    ...d.stale.map((s) => ({ href: `#/ativos/${s.id}`, name: s.name, client: s.client_name, late: true, why: 'Agente sem contacto',
      date: fmtDate(s.last_seen), when: `há ${-days(s.last_seen)} d` })),
    ...renewals.items.map((k) => {
      const late = k.end_date < today;
      return { href: `#/contratos/${k.id}`, name: k.name, client: k.client_name, late,
        why: late ? 'Contrato terminado' : k.auto_renew ? 'Renovação automática' : 'Contrato a renovar',
        date: fmtDate(k.end_date), when: late ? `há ${-days(k.end_date)} d` : `em ${days(k.end_date)} d` };
    }),
  ].sort((a, b) => Number(b.late) - Number(a.late));
  const late = attention.filter((a) => a.late).length;

  const maxType = Math.max(1, ...d.byType.map((t) => t.n));
  const kpi = (label, value, href, ic, tone) => h('div', { class: 'col-sm-6 col-lg-3' },
    h('a', { class: 'card card-sm card-link', href },
      h('div', { class: 'card-body' }, h('div', { class: 'row align-items-center' },
        h('div', { class: 'col-auto' }, h('span', { class: `bg-${tone} text-white avatar` }, icon(ic))),
        h('div', { class: 'col' }, h('div', { class: 'fw-medium' }, value), h('div', { class: 'text-secondary' }, label))))));

  setPage(
    pageHead('Dashboard', `${ME.name} · ${new Date().toLocaleDateString('pt-PT', { weekday: 'long', day: 'numeric', month: 'long' })}`),
    h('div', { class: 'row row-cards' },
      kpi('Ativos', d.totals.total, '#/ativos', 'assets', 'primary'),
      kpi('Clientes', d.totals.clients, '#/clientes', 'clients', 'azure'),
      kpi('Em produção', d.totals.producao, '#/ativos?status=em_producao', 'refresh', 'green'),
      kpi('Criticidade crítica', d.totals.criticos, '#/ativos?criticality=critica', 'alert', 'red')),
    card('Requer atenção', attention.length
      ? table(['Motivo', 'Ativo / contrato', 'Cliente', 'Data', { label: 'Prazo', cls: 'num' }], attention.map((a) => h('tr', { 'data-href': a.href },
        h('td', {}, badge(a.why, a.late ? 'danger' : 'warn')),
        h('td', {}, h('a', { href: a.href }, a.name)),
        h('td', { class: 'text-secondary' }, a.client),
        h('td', { class: 'text-secondary' }, a.date),
        h('td', { class: 'text-end' }, a.when))))
      : h('div', { class: 'empty' }, h('p', { class: 'empty-title' }, 'Nada pendente'),
        h('p', { class: 'empty-subtitle text-secondary' }, 'Sem garantias ou contratos a expirar nem agentes em falta.')),
    { cls: 'focal', sub: attention.length ? `${late} em falta · ${attention.length - late} a vencer` : null,
      actions: attention.length ? h('span', { class: `badge ${late ? 'bg-red' : 'bg-orange'} text-white` }, String(attention.length)) : null }),
    h('div', { class: 'row row-cards' },
      h('div', { class: 'col-lg-7' }, card('Ativos por cliente',
        table(['Cliente', 'Código', { label: 'Ativos', cls: 'num' }], d.byClient.map((c) => h('tr', { 'data-href': `#/clientes/${c.id}` },
          h('td', {}, h('a', { href: `#/clientes/${c.id}` }, c.name)),
          h('td', { class: 'text-secondary' }, c.code),
          h('td', { class: 'text-end' }, c.n))), 'Sem clientes.'))),
      h('div', { class: 'col-lg-5' }, card('Ativos por tipo',
        d.byType.length ? h('div', { class: 'd-flex flex-column gap-3' }, d.byType.map((t) => h('a', { class: 'text-reset text-decoration-none', href: `#/ativos?type=${t.id}` },
          h('div', { class: 'd-flex mb-1' }, h('span', {}, t.name), h('span', { class: 'ms-auto fw-medium' }, t.n)),
          h('div', { class: 'progress progress-sm' }, h('div', { class: 'progress-bar bg-primary', style: { width: `${(t.n / maxType) * 100}%` }, role: 'progressbar' })))))
          : h('div', { class: 'text-secondary' }, 'Sem ativos.')))),
    card('Atividade recente',
      table(['Quando', 'Quem', 'Ação', 'Ativo'], d.recent.map((a) => h('tr', a.action === 'delete' ? {} : { 'data-href': `#/ativos/${a.entity_id}` },
        h('td', { class: 'text-secondary' }, fmtDateTime(a.created_at)), h('td', {}, a.actor), h('td', {}, L.action[a.action] || a.action),
        h('td', {}, a.action === 'delete' ? h('span', { class: 'text-secondary' }, a.label) : h('a', { href: `#/ativos/${a.entity_id}` }, a.label)))), 'Sem atividade.')));
}
