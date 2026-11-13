/* Ativos: lista, formulário e detalhe. */
import { GET, L, META, api, badge, canWrite, card, confirmDialog, critBadge, dash, details, field, fmtDate, fmtDateTime, getClients, h, icon, openDialog, select, sourceBadge, statusBadge, table, toast } from '../core.js';
import { pageHead, render, setPage } from '../main.js';
import { ciMapCard } from './clients.js';
import { contractsCard } from './contracts.js';

// ======================================================================= ativos — lista
export async function viewCis(query) {
  const params = new URLSearchParams(query);
  const page = Math.max(0, Number(params.get('page')) || 0);
  const PAGE = 100;
  const apiParams = new URLSearchParams();
  for (const k of ['q', 'client', 'type', 'status', 'criticality', 'site', 'source']) if (params.get(k)) apiParams.set(k, params.get(k));
  const csvUrl = `/api/cis.csv?${apiParams}`;
  apiParams.set('limit', String(PAGE));
  apiParams.set('offset', String(page * PAGE));
  const [data, clients] = await Promise.all([GET(`/api/cis?${apiParams}`), getClients(true)]);

  const go = (changes) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) { if (v === '' || v === null || v === undefined) p.delete(k); else p.set(k, v); }
    if (!('page' in changes)) p.delete('page');
    location.hash = `#/ativos?${p}`;
  };
  const filterSelect = (name, label, options) => select(name, [['', label], ...options], params.get(name) || '',
    { onchange: (e) => go({ [name]: e.target.value }), 'aria-label': label });
  const search = h('input', { type: 'search', placeholder: 'Nome, hostname, nº de série, IP ou etiqueta', value: params.get('q') || '', 'aria-label': 'Pesquisar ativos' });
  const filters = h('form', { class: 'row g-2 align-items-center', onsubmit: (e) => { e.preventDefault(); go({ q: search.value.trim() }); } },
    h('div', { class: 'col-12 col-xl-4' }, h('div', { class: 'input-icon' }, h('span', { class: 'input-icon-addon' }, icon('search')), search)),
    h('div', { class: 'col-6 col-md-3 col-xl' }, filterSelect('client', 'Todos os clientes', clients.map((c) => [c.id, c.name]))),
    h('div', { class: 'col-6 col-md-3 col-xl' }, filterSelect('type', 'Todos os tipos', META.types.map((t) => [t.id, t.name]))),
    h('div', { class: 'col-6 col-md-3 col-xl' }, filterSelect('status', 'Todos os estados', META.statuses.map((s) => [s, L.status[s]]))),
    h('div', { class: 'col-6 col-md-3 col-xl' }, filterSelect('criticality', 'Qualquer criticidade', META.criticalities.map((c) => [c, L.crit[c]]))),
    h('div', { class: 'col-auto' }, h('button', { type: 'button', onclick: () => { location.hash = '#/ativos'; } }, 'Limpar')));

  const rows = data.items.map((ci) => h('tr', { 'data-href': `#/ativos/${ci.id}` },
    h('td', {}, h('a', { href: `#/ativos/${ci.id}` }, ci.name), ci.hostname && ci.hostname !== ci.name ? h('div', { class: 'text-secondary small' }, ci.hostname) : null),
    h('td', { class: 'text-secondary' }, ci.type_name),
    h('td', {}, h('a', { href: `#/clientes/${ci.client_id}`, class: 'text-reset' }, ci.client_name), ci.site_name ? h('div', { class: 'text-secondary small' }, ci.site_name) : null),
    h('td', {}, statusBadge(ci.status)),
    h('td', {}, critBadge(ci.criticality)),
    h('td', { class: 'text-secondary font-monospace small' }, dash(ci.ip_address)),
    h('td', { class: 'text-secondary font-monospace small' }, dash(ci.serial_number)),
    h('td', {}, sourceBadge(ci.source))));

  const newHref = params.get('client') ? `#/ativos/novo?client=${params.get('client')}` : '#/ativos/novo';
  const pager = data.total > PAGE ? h('div', { class: 'card-footer d-flex align-items-center' },
    h('p', { class: 'm-0 text-secondary' }, `${page * PAGE + 1}–${Math.min((page + 1) * PAGE, data.total)} de ${data.total}`),
    h('ul', { class: 'pagination m-0 ms-auto' },
      h('li', { class: `page-item${page === 0 ? ' disabled' : ''}` }, h('a', { class: 'page-link', href: '#', onclick: (e) => { e.preventDefault(); if (page) go({ page: page - 1 }); } }, 'Anterior')),
      h('li', { class: `page-item${(page + 1) * PAGE >= data.total ? ' disabled' : ''}` }, h('a', { class: 'page-link', href: '#', onclick: (e) => { e.preventDefault(); if ((page + 1) * PAGE < data.total) go({ page: page + 1 }); } }, 'Seguinte')))) : null;
  setPage(
    pageHead('Ativos', `${data.total} resultado(s)`,
      h('a', { class: 'btn', href: csvUrl, download: '' }, icon('download'), 'Exportar CSV'),
      canWrite() ? h('a', { class: 'btn primary', href: newHref }, icon('plus'), 'Novo ativo') : null),
    h('div', { class: 'card' },
      h('div', { class: 'card-body border-bottom py-3' }, filters),
      table(['Nome', 'Tipo', 'Cliente / local', 'Estado', 'Criticidade', 'IP', 'Nº de série', 'Origem'], rows, 'Nenhum ativo encontrado.'),
      pager));
}

// ======================================================================= ativos — formulário
export async function viewCiForm(id, query) {
  if (!canWrite()) throw new Error('Sem permissão de escrita.');
  const ci = id ? await GET(`/api/cis/${id}`) : null;
  const clients = await getClients(true);
  const presetClient = ci ? ci.client_id : Number(query && query.get('client')) || (clients.length === 1 ? clients[0].id : '');

  const siteSel = select('site_id', [['', '— sem local —']], '');
  async function loadSites(clientId, selected) {
    siteSel.replaceChildren(h('option', { value: '' }, '— sem local —'));
    if (!clientId) return;
    const c = await GET(`/api/clients/${clientId}`);
    for (const s of c.sites) siteSel.append(h('option', { value: s.id }, s.name));
    siteSel.value = selected || '';
  }

  const clientSel = ci
    ? h('input', { value: ci.client_name, disabled: true })
    : select('client_id', [['', '— escolher —'], ...clients.map((c) => [c.id, c.name])], presetClient,
      { required: true, onchange: (e) => loadSites(e.target.value) });

  const attrsBox = h('div', { class: 'row' });
  const otherAttrs = h('textarea', { name: '_other', rows: 3, placeholder: 'chave=valor (um por linha)' });
  const attrs = ci ? { ...ci.attributes } : {};
  function renderTypeFields(typeId) {
    const t = META.types.find((x) => String(x.id) === String(typeId));
    const fields = t ? t.fields : [];
    attrsBox.replaceChildren(...fields.map((f) => field(f.replace(/_/g, ' '), h('input', { 'data-attr': f, value: attrs[f] ?? '' }), 'col-md-4')));
    otherAttrs.value = Object.entries(attrs).filter(([k]) => !fields.includes(k)).map(([k, v]) => `${k}=${v}`).join('\n');
  }
  const typeSel = select('type_id', [['', '— escolher —'], ...META.types.map((t) => [t.id, `${t.name} (${t.category})`])], ci?.type_id ?? '',
    { required: true, onchange: (e) => { collectAttrs(); renderTypeFields(e.target.value); } });
  function collectAttrs() {
    for (const inp of attrsBox.querySelectorAll('[data-attr]')) {
      if (inp.value.trim()) attrs[inp.dataset.attr] = inp.value.trim(); else delete attrs[inp.dataset.attr];
    }
  }

  const v = (k) => (ci ? ci[k] ?? '' : '');
  const input = (name, extra = {}) => h('input', { name, value: v(name), ...extra });
  const err = h('div', { class: 'alert alert-danger error', hidden: true });
  const submit = h('button', { class: 'primary', type: 'submit' }, ci ? 'Guardar alterações' : 'Criar ativo');
  const section = (title, ...kids) => h('div', { class: 'mb-2' }, h('h3', { class: 'card-title mb-3' }, title), h('div', { class: 'row' }, kids));

  const form = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    err.hidden = true;
    submit.disabled = true;
    try {
      collectAttrs();
      const fd = new FormData(form);
      const body = {};
      for (const [k, val] of fd) if (!k.startsWith('_')) body[k] = val;
      const finalAttrs = {};
      const t = META.types.find((x) => String(x.id) === String(body.type_id));
      for (const f of t ? t.fields : []) if (attrs[f] !== undefined) finalAttrs[f] = attrs[f];
      for (const line of String(fd.get('_other') || '').split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) finalAttrs[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      body.attributes = finalAttrs;
      const saved = ci ? await api('PUT', `/api/cis/${ci.id}`, body) : await api('POST', '/api/cis', body);
      toast(ci ? 'Ativo atualizado.' : 'Ativo criado.');
      location.hash = `#/ativos/${saved.id}`;
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
    section('Identificação',
      field('Nome *', input('name', { required: true }), 'col-md-6'),
      field('Tipo *', typeSel, 'col-md-6'),
      field('Cliente *', clientSel, 'col-md-6'),
      field('Local', siteSel, 'col-md-6'),
      field('Estado', select('status', META.statuses.map((s) => [s, L.status[s]]), ci?.status ?? 'em_producao'), 'col-md-3'),
      field('Criticidade', select('criticality', META.criticalities.map((c) => [c, L.crit[c]]), ci?.criticality ?? 'media'), 'col-md-3'),
      field('Ambiente', select('environment', [['', '—'], ...META.environments.map((x) => [x, L.env[x]])], ci?.environment ?? ''), 'col-md-3'),
      field('Responsável', input('owner'), 'col-md-3')),
    h('hr', { class: 'my-3' }),
    section('Técnico',
      field('Hostname', input('hostname'), 'col-md-4'),
      field('Endereço IP', input('ip_address'), 'col-md-4'),
      field('Sistema operativo', input('os'), 'col-md-4'),
      field('Fabricante', input('manufacturer'), 'col-md-3'),
      field('Modelo', input('model'), 'col-md-3'),
      field('Nº de série', input('serial_number'), 'col-md-3'),
      field('Etiqueta de inventário', input('asset_tag'), 'col-md-3')),
    h('hr', { class: 'my-3' }),
    section('Ciclo de vida',
      field('Data de compra', input('purchase_date', { type: 'date' }), 'col-md-3'),
      field('Fim de garantia', input('warranty_end', { type: 'date' }), 'col-md-3')),
    h('hr', { class: 'my-3' }),
    h('h3', { class: 'card-title mb-3' }, 'Atributos'),
    attrsBox,
    field('Outros atributos', otherAttrs),
    field('Notas', h('textarea', { name: 'notes', value: v('notes'), rows: 3 }))),
  h('div', { class: 'card-footer text-end' }, h('div', { class: 'btn-list justify-content-end' },
    h('a', { class: 'btn', href: ci ? `#/ativos/${ci.id}` : '#/ativos' }, 'Cancelar'), submit)));

  setPage(pageHead(ci
    ? { title: `Editar ${ci.name}`, crumbs: [['Ativos', '#/ativos'], [ci.name, `#/ativos/${ci.id}`]] }
    : { title: 'Novo ativo', crumbs: [['Ativos', '#/ativos']] }), form);
  renderTypeFields(ci?.type_id);
  if (presetClient) await loadSites(presetClient, ci?.site_id);
}

// ======================================================================= ativos — detalhe
export async function viewCi(id) {
  const [ci, impact, history, contracts, tickets] = await Promise.all([GET(`/api/cis/${id}`), GET(`/api/cis/${id}/impact`),
    GET(`/api/cis/${id}/history`), GET(`/api/cis/${id}/contracts`), GET(`/api/cis/${id}/tickets`)]);

  const relItem = (r, verbs) => h('div', { class: 'list-group-item' }, h('div', { class: 'row align-items-center g-2' },
    h('div', { class: 'col-auto text-secondary small rel-verb' }, verbs[r.type] || r.type),
    h('div', { class: 'col text-truncate' }, h('a', { href: `#/ativos/${r.ci_id}` }, r.name), h('div', { class: 'text-secondary small' }, r.type_name)),
    h('div', { class: 'col-auto' }, statusBadge(r.status)),
    canWrite() ? h('div', { class: 'col-auto' }, h('button', { class: 'link text-danger small', title: 'Remover relação', onclick: async () => {
      if (await confirmDialog('Remover relação', `Remover a relação com "${r.name}"?`, 'Remover')) {
        await api('DELETE', `/api/relationships/${r.id}`); toast('Relação removida.'); render();
      }
    } }, 'Remover')) : null));

  const impactList = (items, empty) => (items.length
    ? h('div', { class: 'list-group list-group-flush' }, items.map((x) => h('div', { class: 'list-group-item' }, h('div', { class: 'row align-items-center g-2' },
      h('div', { class: 'col-auto' }, h('span', { class: 'badge bg-secondary-lt', title: 'Nível de dependência' }, x.depth)),
      h('div', { class: 'col text-truncate' }, h('a', { href: `#/ativos/${x.id}` }, x.name), h('div', { class: 'text-secondary small' }, x.type_name)),
      h('div', { class: 'col-auto' }, critBadge(x.criticality))))))
    : h('div', { class: 'card-body text-secondary' }, empty));

  const attrs = Object.entries(ci.attributes || {});
  const nImpact = impact.impacted.length;
  const impactPanel = h('div', { class: 'card', id: 'painel-impacto' },
    h('div', { class: 'card-header' }, h('h2', { class: 'card-title' }, 'Análise de impacto')),
    h('div', { class: 'card-body pb-2' }, h('div', { class: 'subheader' }, 'Afetados se este ativo falhar')),
    impactList(impact.impacted, 'Nenhum ativo depende deste.'),
    h('div', { class: 'card-body pb-2 border-top' }, h('div', { class: 'subheader' }, 'Dependências deste ativo')),
    impactList(impact.dependencies, 'Não depende de outros ativos.'));
  const sub = [`#${ci.id}`, ci.type_name, ci.hostname, ci.ip_address, ci.site_name].filter(Boolean).join(' · ');
  setPage(
    pageHead({ title: ci.name, crumbs: [['Ativos', '#/ativos'], [ci.client_name, `#/clientes/${ci.client_id}`]] }, sub,
      h('a', { class: `btn ${nImpact ? 'btn-outline-danger' : ''}`, href: '#painel-impacto', title: 'Ver análise de impacto',
        onclick: (e) => { e.preventDefault(); impactPanel.scrollIntoView({ behavior: 'smooth', block: 'start' }); } },
      icon('alert'), `${nImpact} ${nImpact === 1 ? 'ativo afetado' : 'ativos afetados'} se falhar`),
      canWrite() ? h('button', { class: 'danger', onclick: async () => {
        if (await confirmDialog('Eliminar ativo', `Eliminar "${ci.name}" e todas as suas relações? Esta ação não pode ser anulada.`)) {
          await api('DELETE', `/api/cis/${ci.id}`); toast('Ativo eliminado.'); location.hash = '#/ativos';
        }
      } }, icon('trash'), 'Eliminar') : null,
      canWrite() ? h('a', { class: 'btn primary', href: `#/ativos/${ci.id}/editar` }, icon('edit'), 'Editar') : null),
    h('div', { class: 'row row-cards' },
      h('div', { class: 'col-lg-7 d-flex flex-column gap-3' },
        card('Detalhes', details([
          ['Estado', statusBadge(ci.status)], ['Criticidade', critBadge(ci.criticality)],
          ['Ambiente', L.env[ci.environment]], ['Responsável', ci.owner],
          ['Hostname', ci.hostname], ['Endereço IP', ci.ip_address],
          ['Fabricante', ci.manufacturer], ['Modelo', ci.model],
          ['Nº de série', ci.serial_number], ['Etiqueta', ci.asset_tag],
          ['Sistema operativo', ci.os],
          ['Data de compra', ci.purchase_date ? fmtDate(ci.purchase_date) : null],
          ['Fim de garantia', ci.warranty_end ? fmtDate(ci.warranty_end) : null],
          ['Origem', sourceBadge(ci.source)],
          ci.last_seen ? ['Último contacto', fmtDateTime(ci.last_seen)] : null,
          ['Criado / alterado', `${fmtDateTime(ci.created_at)} / ${fmtDateTime(ci.updated_at)}`],
          ['Notas', ci.notes]])),
        card('Atributos', attrs.length ? details(attrs.map(([k, val]) => [k.replace(/_/g, ' '), String(val)]))
          : h('div', { class: 'text-secondary' }, 'Sem atributos adicionais.')),
        contractsCard(contracts, { title: 'Contratos' }),
        ticketsCard(tickets, { ci })),
      h('div', { class: 'col-lg-5 d-flex flex-column gap-3' },
        h('div', { class: 'card' },
          h('div', { class: 'card-header' }, h('h2', { class: 'card-title' }, `Relações · ${ci.outgoing.length + ci.incoming.length}`),
            canWrite() ? h('div', { class: 'card-actions' }, h('button', { class: 'btn-sm', onclick: () => relationDialog(ci) }, icon('link'), 'Adicionar relação')) : null),
          ci.outgoing.length || ci.incoming.length ? h('div', { class: 'list-group list-group-flush' },
            ci.outgoing.map((r) => relItem(r, L.rel)), ci.incoming.map((r) => relItem(r, L.relInv)))
            : h('div', { class: 'card-body text-secondary' }, 'Sem relações. Adicione-as para obter análise de impacto.')),
        impactPanel,
        card(`Histórico · ${history.length}`,
          history.length ? h('div', { class: 'history-scroll' }, h('ul', { class: 'timeline timeline-simple' }, history.map(historyItem))) : h('div', { class: 'text-secondary' }, 'Sem histórico.')))),
    ci.outgoing.length || ci.incoming.length ? ciMapCard(ci) : null);
}

export function historyItem(a) {
  const changes = a.changes && typeof a.changes === 'object' ? Object.entries(a.changes) : [];
  return h('li', { class: 'timeline-event' },
    h('div', { class: 'timeline-event-icon bg-secondary-lt' }, icon(a.action === 'delete' ? 'trash' : a.action === 'create' ? 'plus' : 'edit')),
    h('div', { class: 'card timeline-event-card' }, h('div', { class: 'card-body py-2' },
      h('div', { class: 'text-secondary float-end small' }, fmtDateTime(a.created_at)),
      h('div', { class: 'fw-medium' }, a.actor),
      h('div', {}, a.label && a.label.includes('→') ? `${L.action[a.action] || a.action} relação: ${a.label.replace(/#\d+# /g, '')}` : (L.action[a.action] || a.action)),
      changes.length && a.action === 'update' ? h('ul', { class: 'small text-secondary mb-0 ps-3' }, changes.map(([k, val]) => h('li', {},
        h('span', { class: 'text-body' }, L.field[k] || k), ': ',
        Array.isArray(val) ? `${dash(val[0])} → ${dash(val[1])}` : String(val)))) : null)));
}

export async function relationDialog(ci) {
  // O outro ativo é escolhido por pesquisa no servidor (um cliente pode ter milhares de ativos)
  const pick = select('other', [], '', { required: true, size: 8, class: 'mt-2', 'aria-label': 'Outro ativo' });
  const q = h('input', { type: 'search', placeholder: 'Procurar por nome, hostname ou nº de série', 'aria-label': 'Procurar ativo' });
  const note = h('div', { class: 'form-hint' });
  async function load() {
    const term = q.value.trim();
    const r = await GET(`/api/cis?client=${ci.client_id}&limit=50${term ? `&q=${encodeURIComponent(term)}` : ''}`);
    const items = r.items.filter((x) => x.id !== ci.id);
    pick.replaceChildren(...items.map((o) => h('option', { value: o.id }, `${o.name} (${o.type_name})`)));
    if (items[0]) pick.value = items[0].id;
    note.textContent = r.total > 50 ? `A mostrar 50 de ${r.total}. Escreva para filtrar.` : items.length ? '' : 'Nenhum ativo corresponde.';
  }
  let timer = null;
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load().catch(() => {}), 200); });
  await load();
  if (!pick.options.length && !q.value) { toast('Não existem outros ativos deste cliente para relacionar.', true); return; }
  openDialog('Adicionar relação', [
    field('Direção', select('dir', [['out', `"${ci.name}" …`], ['in', `… "${ci.name}"`]], 'out')),
    field('Tipo de relação', select('type', META.relTypes.map((t) => [t, L.rel[t]]), 'depende_de')),
    h('div', { class: 'mb-3' }, h('label', { class: 'form-label' }, 'Outro ativo'), q, pick, note),
    h('p', { class: 'form-hint mb-0' }, 'Exemplo: "ERP" corre em "SRV-APP01". A origem da relação depende do destino, o que alimenta a análise de impacto.')],
  async (fd) => {
    const other = Number(fd.get('other'));
    if (!other) throw new Error('Escolha o outro ativo.');
    const out = fd.get('dir') === 'out';
    await api('POST', '/api/relationships', { source_id: out ? ci.id : other, target_id: out ? other : ci.id, type: fd.get('type') });
    toast('Relação criada.');
    render();
  });
}

// ======================================================================= tickets / incidentes
/** Cartão de tickets ligados (no ativo: permite ligar e desligar; no cliente: só leitura). */
export function ticketsCard(list, { ci = null, showCis = false, title = 'Tickets' } = {}) {
  const open = list.filter((t) => !t.closed).length;
  const ref = (t) => (t.url ? h('a', { href: t.url, target: '_blank', rel: 'noopener noreferrer' }, `${t.system} ${t.external_id}`) : `${t.system} ${t.external_id}`);
  return h('div', { class: 'card' },
    h('div', { class: 'card-header' }, h('h2', { class: 'card-title' }, `${title} · ${open} aberto(s)`),
      ci && canWrite() ? h('div', { class: 'card-actions' }, h('button', { class: 'btn-sm', onclick: () => ticketDialog(ci) }, icon('ticket'), 'Ligar ticket')) : null),
    list.length ? h('div', { class: 'list-group list-group-flush' }, list.map((t) => h('div', { class: 'list-group-item' }, h('div', { class: 'row align-items-center g-2' },
      h('div', { class: 'col-auto' }, t.closed ? badge('Fechado') : badge('Aberto', 'warn')),
      h('div', { class: 'col text-truncate' }, ref(t), h('div', { class: 'text-secondary small text-truncate' }, [t.title, t.status, showCis && t.ci_names].filter(Boolean).join(' · '))),
      ci && canWrite() ? h('div', { class: 'col-auto' }, h('button', { class: 'link text-danger small', title: 'Desligar ticket', onclick: async () => {
        if (await confirmDialog('Desligar ticket', `Desligar o ticket ${t.system} ${t.external_id} deste ativo?`, 'Desligar')) {
          await api('DELETE', `/api/cis/${ci.id}/tickets/${t.id}`); toast('Ticket desligado.'); render();
        }
      } }, 'Desligar')) : null))))
      : h('div', { class: 'card-body text-secondary' }, ci ? 'Sem tickets. As ferramentas de helpdesk podem ligá-los automaticamente (ver README, "Integração com tickets").' : 'Sem tickets.'));
}

export function ticketDialog(ci) {
  openDialog(`Ligar ticket — ${ci.name}`, h('div', { class: 'row' },
    field('Sistema', h('input', { name: 'system', required: true, placeholder: 'ex.: GLPI, Jira, Freshservice', list: 'ticket-systems' }), 'col-md-6'),
    h('datalist', { id: 'ticket-systems' }, ['GLPI', 'Jira', 'Freshservice', 'Zendesk', 'ServiceNow', 'Zammad', 'osTicket'].map((x) => h('option', { value: x }))),
    field('Nº do ticket', h('input', { name: 'external_id', required: true, placeholder: 'ex.: 4711' }), 'col-md-6'),
    field('Título', h('input', { name: 'title' }), 'col-12'),
    field('Estado', h('input', { name: 'status', placeholder: 'ex.: Em curso' }), 'col-md-6'),
    field('Ligação (URL)', h('input', { name: 'url', type: 'url', placeholder: 'https://…' }), 'col-md-6')),
  async (fd) => {
    await api('POST', `/api/cis/${ci.id}/tickets`, Object.fromEntries(fd));
    toast('Ticket ligado.');
    render();
  }, { wide: true });
}
