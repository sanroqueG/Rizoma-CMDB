/* Contratos: lista com filtros e renovações, detalhe com ativos ligados, formulário. */
import { GET, L, META, api, badge, canWrite, card, check, confirmDialog, dash, daysUntil, details, field, fmtDate, fmtMoney, getClients, h, icon, pagerFooter, select, statusBadge, table, toast } from '../core.js';
import { pageHead, setPage } from '../main.js';
import { historyItem } from './cis.js';

// ======================================================================= utilitários
export const contractEndBadge = (k) => {
  if (k.status !== 'ativo') return badge(L.cstatus[k.status] || k.status);
  if (!k.end_date) return h('span', { class: 'text-secondary' }, 'sem fim');
  const d = daysUntil(k.end_date);
  const noticeLeft = d - (k.notice_days || 0);
  if (d < 0) return badge(`terminou há ${-d} d`, 'danger');
  if (noticeLeft <= 0) return badge(k.auto_renew ? `renova em ${d} d` : `termina em ${d} d`, k.auto_renew ? 'info' : 'danger');
  if (noticeLeft <= 60) return badge(`termina em ${d} d`, 'warn');
  return h('span', { class: 'text-secondary' }, `em ${d} d`);
};
export const contractCost = (k) => (k.cost === null || k.cost === undefined ? '—'
  : k.billing && k.billing !== 'unico' ? `${fmtMoney(k.cost)} / ${({ mensal: 'mês', trimestral: 'trimestre', anual: 'ano' })[k.billing]}` : fmtMoney(k.cost));

// ======================================================================= lista
export async function viewContracts(query) {
  const params = new URLSearchParams(query);
  const apiParams = new URLSearchParams();
  for (const k of ['client', 'kind', 'expiring', 'q']) if (params.get(k)) apiParams.set(k, params.get(k));
  // Estado: por omissão só os ativos (exceto no filtro de renovações); "todos" = sem filtro
  const statusValue = params.get('status') === 'todos' ? '' : params.get('status') || (params.get('expiring') ? '' : 'ativo');
  if (statusValue) apiParams.set('status', statusValue);
  const PAGE = 100;
  const page = Math.max(0, Number(params.get('page')) || 0);
  apiParams.set('limit', String(PAGE));
  apiParams.set('offset', String(page * PAGE));
  const [data, clients] = await Promise.all([GET(`/api/contracts?${apiParams}`), getClients(true)]);
  const go = (changes) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) { if (v === '' || v === null) p.delete(k); else p.set(k, v); }
    if (!('page' in changes)) p.delete('page');
    location.hash = `#/contratos?${p}`;
  };
  const filterSelect = (name, label, options, value) => select(name, [['', label], ...options], value ?? params.get(name) ?? '',
    { onchange: (e) => go({ [name]: e.target.value }), 'aria-label': label });
  const search = h('input', { type: 'search', placeholder: 'Nome, fornecedor ou referência', value: params.get('q') || '', 'aria-label': 'Pesquisar contratos' });

  const filters = h('form', { class: 'row g-2 align-items-center', onsubmit: (e) => { e.preventDefault(); go({ q: search.value.trim() }); } },
    h('div', { class: 'col-12 col-xl-4' }, h('div', { class: 'input-icon' }, h('span', { class: 'input-icon-addon' }, icon('search')), search)),
    h('div', { class: 'col-6 col-md-3 col-xl' }, filterSelect('client', 'Todos os clientes', clients.map((c) => [c.id, c.name]))),
    h('div', { class: 'col-6 col-md-3 col-xl' }, filterSelect('kind', 'Todos os tipos', META.contractKinds.map((k) => [k, L.kind[k]]))),
    h('div', { class: 'col-6 col-md-3 col-xl' }, select('status', [['', 'Qualquer estado'], ...META.contractStatuses.map((s) => [s, L.cstatus[s]])], statusValue,
      { onchange: (e) => go({ status: e.target.value === '' ? 'todos' : e.target.value }), 'aria-label': 'Estado' })),
    h('div', { class: 'col-6 col-md-3 col-xl' }, filterSelect('expiring', 'Qualquer data de fim', [['30', 'A terminar em 30 dias'], ['90', 'A terminar em 90 dias'], ['180', 'A terminar em 180 dias']])),
    h('div', { class: 'col-auto' }, h('button', { type: 'button', onclick: () => { location.hash = '#/contratos'; } }, 'Limpar')));

  const rows = data.items.map((k) => h('tr', { 'data-href': `#/contratos/${k.id}` },
    h('td', {}, h('a', { href: `#/contratos/${k.id}` }, k.name), k.reference ? h('div', { class: 'text-secondary small' }, k.reference) : null),
    h('td', { class: 'text-secondary' }, L.kind[k.kind] || k.kind),
    h('td', {}, dash(k.vendor)),
    h('td', {}, h('a', { href: `#/clientes/${k.client_id}`, class: 'text-reset' }, k.client_name)),
    h('td', { class: 'text-secondary' }, k.end_date ? fmtDate(k.end_date) : '—'),
    h('td', {}, contractEndBadge(k), k.auto_renew ? h('div', { class: 'text-secondary small' }, 'renovação automática') : null),
    h('td', { class: 'text-end' }, contractCost(k)),
    h('td', { class: 'text-end' }, k.ci_count || '—')));

  setPage(
    pageHead('Contratos', `${data.total} contrato(s) · custo anual dos ativos: ${fmtMoney(data.annual_cost)}`,
      canWrite() ? h('a', { class: 'btn primary', href: params.get('client') ? `#/contratos/novo?client=${params.get('client')}` : '#/contratos/novo' }, icon('plus'), 'Novo contrato') : null),
    h('div', { class: 'card' },
      h('div', { class: 'card-body border-bottom py-3' }, filters),
      table(['Contrato', 'Tipo', 'Fornecedor', 'Cliente', 'Fim', 'Situação', { label: 'Custo', cls: 'num' }, { label: 'Ativos', cls: 'num' }],
        rows, 'Nenhum contrato encontrado.'),
      pagerFooter(page, PAGE, data.total, (p) => go({ page: p }))));
}

// ======================================================================= formulário
export async function viewContractForm(id, query) {
  if (!canWrite()) throw new Error('Sem permissão de escrita.');
  const k = id ? await GET(`/api/contracts/${id}`) : null;
  const clients = await getClients(true);
  const presetClient = k ? k.client_id : Number(query && query.get('client')) || (clients.length === 1 ? clients[0].id : '');
  const v = (f) => (k ? k[f] ?? '' : '');
  const input = (name, extra = {}) => h('input', { name, value: v(name), ...extra });
  const err = h('div', { class: 'alert alert-danger error', hidden: true });
  const submit = h('button', { class: 'primary', type: 'submit' }, k ? 'Guardar alterações' : 'Criar contrato');

  // Ativos ligados (lista de seleção com pesquisa)
  const ciBox = h('div', { class: 'ci-picker border rounded p-2' });
  const ciFilter = h('input', { type: 'search', placeholder: 'Filtrar ativos', 'aria-label': 'Filtrar ativos', class: 'mb-2' });
  // Pesquisa no servidor: mostra os ativos já escolhidos e até 100 resultados do filtro
  const selected = new Set((k ? k.cis : []).map((c) => c.id));
  const known = new Map((k ? k.cis : []).map((c) => [c.id, c]));
  let cis = [];
  let currentClient = presetClient;
  let more = 0;
  function drawCis() {
    const shown = [...[...selected].map((id) => known.get(id)).filter(Boolean), ...cis.filter((c) => !selected.has(c.id))];
    ciBox.replaceChildren(...(shown.length ? shown.map((c) => check(
      h('input', { type: 'checkbox', checked: selected.has(c.id), onchange: (e) => { if (e.target.checked) { selected.add(c.id); known.set(c.id, c); } else selected.delete(c.id); } }),
      [c.name, h('span', { class: 'text-secondary small ms-1' }, c.type_name)], 'mb-1'))
      : [h('span', { class: 'text-secondary' }, currentClient ? 'Nenhum ativo corresponde.' : 'Escolha o cliente primeiro.')]),
    more ? h('div', { class: 'form-hint' }, `Mais ${more} ativo(s): escreva para filtrar.`) : null);
  }
  async function searchCis() {
    if (!currentClient) { cis = []; more = 0; drawCis(); return; }
    const term = ciFilter.value.trim();
    const r = await GET(`/api/cis?client=${currentClient}&limit=100${term ? `&q=${encodeURIComponent(term)}` : ''}`);
    cis = r.items;
    more = Math.max(0, r.total - r.items.length);
    drawCis();
  }
  async function loadCis(clientId) {
    if (!k || Number(clientId) !== k.client_id) { selected.clear(); known.clear(); }
    currentClient = clientId;
    await searchCis();
  }
  let ciTimer = null;
  ciFilter.addEventListener('input', () => { clearTimeout(ciTimer); ciTimer = setTimeout(() => searchCis().catch(() => {}), 200); });

  const clientSel = k ? h('input', { value: k.client_name, disabled: true })
    : select('client_id', [['', '— escolher —'], ...clients.map((c) => [c.id, c.name])], presetClient, { required: true, onchange: (e) => loadCis(e.target.value) });
  const section = (title, ...kids) => [h('h3', { class: 'card-title mb-3' }, title), h('div', { class: 'row' }, kids)];

  const form = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    err.hidden = true;
    submit.disabled = true;
    try {
      const fd = new FormData(form);
      /** @type {Record<string, any>} */
      const body = Object.fromEntries([...fd].filter(([key]) => !key.startsWith('_')));
      body.auto_renew = fd.get('auto_renew') === 'on';
      body.ci_ids = [...selected];
      const saved = k ? await api('PUT', `/api/contracts/${k.id}`, body) : await api('POST', '/api/contracts', body);
      toast(k ? 'Contrato atualizado.' : 'Contrato criado.');
      location.hash = `#/contratos/${saved.id}`;
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      window.scrollTo(0, 0);
    } finally {
      submit.disabled = false;
    }
  } },
  h('div', { class: 'card-body' },
    err,
    section('Contrato',
      field('Nome *', input('name', { required: true, placeholder: 'ex.: Microsoft 365 Business Premium' }), 'col-md-6'),
      field('Cliente *', clientSel, 'col-md-6'),
      field('Tipo', select('kind', META.contractKinds.map((x) => [x, L.kind[x]]), k?.kind ?? 'licenca'), 'col-md-3'),
      field('Estado', select('status', META.contractStatuses.map((x) => [x, L.cstatus[x]]), k?.status ?? 'ativo'), 'col-md-3'),
      field('Fornecedor', input('vendor'), 'col-md-3'),
      field('Referência / nº de contrato', input('reference'), 'col-md-3'),
      field('Responsável', input('owner'), 'col-md-6'),
      field('Quantidade (licenças, utilizadores…)', input('quantity', { type: 'number', min: 0, step: 1 }), 'col-md-6')),
    h('hr', { class: 'my-3' }),
    section('Datas e renovação',
      field('Início', input('start_date', { type: 'date' }), 'col-md-3'),
      field('Fim', input('end_date', { type: 'date' }), 'col-md-3'),
      field('Pré-aviso de denúncia (dias)', input('notice_days', { type: 'number', min: 0, step: 1, placeholder: 'ex.: 30' }), 'col-md-3'),
      h('div', { class: 'col-md-3 mb-3 d-flex align-items-end' },
        h('label', { class: 'form-check form-switch mb-2' }, h('input', { type: 'checkbox', name: 'auto_renew', checked: k?.auto_renew }), h('span', { class: 'form-check-label' }, 'Renovação automática')))),
    h('hr', { class: 'my-3' }),
    section('Custo',
      field('Valor (€)', input('cost', { inputmode: 'decimal', placeholder: 'ex.: 125,50' }), 'col-md-3'),
      field('Periodicidade', select('billing', [['', '—'], ...META.billing.map((x) => [x, L.billing[x]])], k?.billing ?? ''), 'col-md-3')),
    h('hr', { class: 'my-3' }),
    h('h3', { class: 'card-title mb-3' }, 'Ativos abrangidos'),
    h('div', { class: 'mb-3' }, ciFilter, ciBox),
    field('Notas', h('textarea', { name: 'notes', value: v('notes'), rows: 3 }))),
  h('div', { class: 'card-footer' }, h('div', { class: 'btn-list justify-content-end' },
    h('a', { class: 'btn', href: k ? `#/contratos/${k.id}` : '#/contratos' }, 'Cancelar'), submit)));

  setPage(pageHead(k
    ? { title: `Editar ${k.name}`, crumbs: [['Contratos', '#/contratos'], [k.name, `#/contratos/${k.id}`]] }
    : { title: 'Novo contrato', crumbs: [['Contratos', '#/contratos']] }), form);
  await loadCis(presetClient);
}

// ======================================================================= detalhe
export async function viewContract(id) {
  const k = await GET(`/api/contracts/${id}`);
  setPage(
    pageHead({ title: k.name, crumbs: [['Contratos', '#/contratos'], [k.client_name, `#/clientes/${k.client_id}`]] },
      [L.kind[k.kind] || k.kind, k.vendor, k.reference].filter(Boolean).join(' · '),
      canWrite() ? h('button', { class: 'danger', onclick: async () => {
        if (await confirmDialog('Eliminar contrato', `Eliminar o contrato "${k.name}"? Os ativos não são afetados.`)) {
          await api('DELETE', `/api/contracts/${k.id}`); toast('Contrato eliminado.'); location.hash = '#/contratos';
        }
      } }, icon('trash'), 'Eliminar') : null,
      canWrite() ? h('a', { class: 'btn primary', href: `#/contratos/${k.id}/editar` }, icon('edit'), 'Editar') : null),
    h('div', { class: 'row row-cards' },
      h('div', { class: 'col-lg-7 d-flex flex-column gap-3' },
        card('Detalhes', details([
          ['Estado', badge(L.cstatus[k.status] || k.status, k.status === 'ativo' ? 'ok' : '')],
          ['Situação', contractEndBadge(k)],
          ['Início', k.start_date ? fmtDate(k.start_date) : null],
          ['Fim', k.end_date ? fmtDate(k.end_date) : null],
          ['Renovação automática', k.auto_renew ? 'Sim' : 'Não'],
          ['Pré-aviso de denúncia', k.notice_days ? `${k.notice_days} dias` : null],
          ['Quantidade', k.quantity],
          ['Custo', contractCost(k)],
          ['Custo anual', k.annual_cost !== null ? fmtMoney(k.annual_cost) : null],
          ['Responsável', k.owner],
          ['Notas', k.notes]])),
        card(`Ativos abrangidos · ${k.cis.length}`,
          table(['Ativo', 'Tipo', 'Estado', 'Nº de série'], k.cis.map((c) => h('tr', { 'data-href': `#/ativos/${c.id}` },
            h('td', {}, h('a', { href: `#/ativos/${c.id}` }, c.name)), h('td', { class: 'text-secondary' }, c.type_name), h('td', {}, statusBadge(c.status)),
            h('td', { class: 'text-secondary font-monospace small' }, dash(c.serial_number)))), 'Nenhum ativo ligado a este contrato.'))),
      h('div', { class: 'col-lg-5' },
        card(`Histórico · ${k.history.length}`,
          k.history.length ? h('div', { class: 'history-scroll' }, h('ul', { class: 'timeline timeline-simple' }, k.history.map(historyItem))) : h('div', { class: 'text-secondary' }, 'Sem histórico.')))));
}

/** Cartão de contratos (usado no cliente e no ativo). */
/**
 * @param {any[]} list
 * @param {{ clientId?: number, title?: string }} [opts]
 */
export function contractsCard(list, { clientId, title = 'Contratos' } = {}) {
  const active = list.filter((k) => k.status === 'ativo');
  const annual = active.reduce((s, k) => s + (k.annual_cost || 0), 0);
  return card(`${title} · ${active.length}`,
    table(['Contrato', 'Fornecedor', 'Fim', 'Situação'], list.map((k) => h('tr', { 'data-href': `#/contratos/${k.id}` },
      h('td', {}, h('a', { href: `#/contratos/${k.id}` }, k.name), h('div', { class: 'text-secondary small' }, L.kind[k.kind] || k.kind)),
      h('td', {}, dash(k.vendor)), h('td', { class: 'text-secondary' }, k.end_date ? fmtDate(k.end_date) : '—'),
      h('td', {}, contractEndBadge(k)))), 'Sem contratos.'),
    { sub: annual ? `Custo anual dos contratos ativos: ${fmtMoney(annual)}` : null,
      actions: clientId && canWrite() ? h('a', { class: 'btn btn-sm', href: `#/contratos/novo?client=${clientId}` }, icon('plus'), 'Novo contrato') : null });
}
