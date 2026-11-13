/* Clientes, locais, tokens, conector Microsoft 365 / Azure e mapa de relações. */
import { GET, L, api, badge, canWrite, card, check, confirmDialog, dash, details, field, fmtDate, fmtDateTime, h, icon, isAdmin, openDialog, select, table, toast } from '../core.js';
import { pageHead, render, setPage } from '../main.js';
import { ticketsCard } from './cis.js';
import { contractsCard } from './contracts.js';

// ======================================================================= clientes
export async function viewClients() {
  const list = await GET('/api/clients');
  setPage(
    pageHead('Clientes', `${list.length} cliente(s)`, isAdmin() ? h('button', { class: 'primary', onclick: () => clientDialog() }, icon('plus'), 'Novo cliente') : null),
    card(null, table(['Nome', 'Código', 'Contacto', { label: 'Locais', cls: 'num' }, { label: 'Ativos', cls: 'num' }],
      list.map((c) => h('tr', { 'data-href': `#/clientes/${c.id}` },
        h('td', {}, h('a', { href: `#/clientes/${c.id}` }, c.name)), h('td', {}, h('span', { class: 'badge bg-secondary-lt' }, c.code)),
        h('td', {}, dash(c.contact_name), c.contact_email ? h('div', { class: 'text-secondary small' }, c.contact_email) : null),
        h('td', { class: 'text-end' }, c.site_count), h('td', { class: 'text-end' }, h('a', { href: `#/ativos?client=${c.id}` }, c.ci_count)))),
      'Ainda não existem clientes.')));
}

export function clientDialog(c) {
  openDialog(c ? 'Editar cliente' : 'Novo cliente', h('div', { class: 'row' },
    field('Nome', h('input', { name: 'name', required: true, value: c?.name }), 'col-md-8'),
    field('Código', h('input', { name: 'code', required: true, maxlength: 12, value: c?.code, placeholder: 'ex.: ACME' }), 'col-md-4'),
    field('Contacto', h('input', { name: 'contact_name', value: c?.contact_name }), 'col-md-6'),
    field('Email', h('input', { name: 'contact_email', type: 'email', value: c?.contact_email }), 'col-md-6'),
    field('Notas', h('textarea', { name: 'notes', value: c?.notes, rows: 3 }), 'col-12')),
  async (fd) => {
    const body = Object.fromEntries(fd);
    const saved = c ? await api('PUT', `/api/clients/${c.id}`, body) : await api('POST', '/api/clients', body);
    toast('Cliente guardado.');
    if (c) render(); else location.hash = `#/clientes/${saved.id}`;
  }, { wide: true });
}

export async function viewClient(id) {
  const [c, contracts, tickets] = await Promise.all([GET(`/api/clients/${id}`), GET(`/api/clients/${id}/contracts`), GET(`/api/tickets?client=${id}&open=1`)]);
  const siteRows = c.sites.map((s) => h('tr', {},
    h('td', {}, h('a', { href: `#/ativos?client=${c.id}&site=${s.id}` }, s.name)), h('td', { class: 'text-secondary' }, dash(s.address)),
    h('td', { class: 'text-end' }, s.ci_count),
    canWrite() ? h('td', { class: 'text-end text-nowrap' },
      h('button', { class: 'link', onclick: () => siteDialog(c, s) }, 'Editar'), ' · ',
      h('button', { class: 'link text-danger', onclick: async () => {
        if (await confirmDialog('Eliminar local', `Eliminar o local "${s.name}"? Os ativos ficam sem local.`)) {
          await api('DELETE', `/api/sites/${s.id}`); toast('Local eliminado.'); render();
        }
      } }, 'Eliminar')) : null));

  const left = [
    card('Locais', table(['Nome', 'Morada', { label: 'Ativos', cls: 'num' }, ...(canWrite() ? [''] : [])], siteRows, 'Sem locais definidos.'),
      { actions: canWrite() ? h('button', { class: 'btn-sm', onclick: () => siteDialog(c) }, icon('plus'), 'Adicionar local') : null }),
    contractsCard(contracts, { clientId: c.id }),
    tickets.length ? ticketsCard(tickets, { showCis: true, title: 'Incidentes abertos' }) : null,
  ];
  const right = [
    card('Informação', details([['Contacto', c.contact_name], ['Email', c.contact_email], ['Criado em', fmtDate(c.created_at)], ['Notas', c.notes]])),
    card('Ativos por tipo', table(['Tipo', { label: 'Ativos', cls: 'num' }], c.byType.map((t) => h('tr', {},
      h('td', {}, h('a', { href: `#/ativos?client=${c.id}&type=${t.id}` }, t.name)), h('td', { class: 'text-end' }, t.n))), 'Sem ativos.')),
  ];
  if (c.tokens) {
    right.push(card('Tokens de inventário', table(['Nome', 'Último uso', ''], c.tokens.map((t) => h('tr', {},
      h('td', {}, t.name, h('div', { class: 'text-secondary small' }, `criado ${fmtDate(t.created_at)} · `,
        (t.scopes || '').split(',').filter(Boolean).map((sc) => ({ ingest: 'inventário', tickets: 'tickets' })[sc] || sc).join(', '))),
      h('td', { class: 'text-secondary' }, t.last_used ? fmtDateTime(t.last_used) : 'Nunca'),
      h('td', { class: 'text-end' }, h('button', { class: 'link text-danger', onclick: async () => {
        if (await confirmDialog('Revogar token', `Revogar o token "${t.name}"? Os agentes que o usam deixam de conseguir enviar dados.`, 'Revogar')) {
          await api('DELETE', `/api/tokens/${t.id}`); toast('Token revogado.'); render();
        }
      } }, 'Revogar')))), 'Sem tokens.'),
    { sub: 'Usados pelos agentes e pelas integrações de tickets deste cliente.', actions: h('button', { class: 'btn-sm', onclick: () => tokenDialog(c) }, icon('key'), 'Novo token') }));
  }
  if (isAdmin()) right.push(await connectorCard(c));
  setPage(
    pageHead({ title: c.name, crumbs: [['Clientes', '#/clientes'], [c.code]] }, `${c.sites.length} local(is) · ${c.byType.reduce((s, t) => s + t.n, 0)} ativo(s)`,
      h('a', { class: 'btn', href: `#/ativos?client=${c.id}` }, icon('assets'), 'Ver ativos'),
      h('a', { class: 'btn', href: `#/clientes/${c.id}/mapa` }, icon('map'), 'Mapa'),
      h('a', { class: 'btn', href: `#/clientes/${c.id}/relatorio` }, icon('printer'), 'Relatório'),
      isAdmin() ? h('button', { onclick: () => clientDialog(c) }, icon('edit'), 'Editar') : null,
      isAdmin() ? h('button', { class: 'danger', onclick: () => deleteClientDialog(c) }, icon('trash'), 'Eliminar') : null,
      canWrite() ? h('a', { class: 'btn primary', href: `#/ativos/novo?client=${c.id}` }, icon('plus'), 'Novo ativo') : null),
    h('div', { class: 'row row-cards' },
      h('div', { class: 'col-lg-7 d-flex flex-column gap-3' }, left),
      h('div', { class: 'col-lg-5 d-flex flex-column gap-3' }, right)));
}

export function siteDialog(c, s) {
  openDialog(s ? 'Editar local' : `Novo local — ${c.name}`, [
    field('Nome', h('input', { name: 'name', required: true, value: s?.name, placeholder: 'ex.: Sede Lisboa' })),
    field('Morada', h('input', { name: 'address', value: s?.address }))],
  async (fd) => {
    const body = Object.fromEntries(fd);
    if (s) await api('PUT', `/api/sites/${s.id}`, body); else await api('POST', `/api/clients/${c.id}/sites`, body);
    toast('Local guardado.');
    render();
  });
}

export function deleteClientDialog(c) {
  openDialog('Eliminar cliente', [
    h('div', { class: 'alert alert-danger' }, 'Esta ação elimina o cliente e ', h('strong', {}, 'todos os seus ativos, locais, relações, contratos e tokens'), '. Não pode ser anulada.'),
    field(`Escreva o código do cliente (${c.code}) para confirmar`, h('input', { name: 'confirm', required: true, autocomplete: 'off' }))],
  async (fd) => {
    await api('DELETE', `/api/clients/${c.id}?confirm=${encodeURIComponent(fd.get('confirm'))}`);
    toast('Cliente eliminado.');
    location.hash = '#/clientes';
  }, { submitLabel: 'Eliminar definitivamente', danger: true });
}

export function tokenDialog(c) {
  openDialog(`Novo token — ${c.name}`, [
    field('Nome (para identificar onde é usado)', h('input', { name: 'name', required: true, placeholder: 'ex.: GPO sede, GLPI' })),
    h('div', { class: 'mb-3' }, h('label', { class: 'form-label' }, 'Permissões'),
      check(h('input', { type: 'checkbox', name: 'scopes', value: 'ingest', checked: true }), 'Inventário (agentes Windows, Linux e macOS)'),
      check(h('input', { type: 'checkbox', name: 'scopes', value: 'tickets', checked: true }), 'Tickets (ferramentas de helpdesk)'),
      h('div', { class: 'form-hint' }, 'Dê a cada sistema só a permissão de que precisa. Documentação da API: /api/v1/openapi.json'))],
    async (fd, form) => {
      const scopes = fd.getAll('scopes');
      if (!scopes.length) throw new Error('Escolha pelo menos uma permissão.');
      const t = await api('POST', `/api/clients/${c.id}/tokens`, { name: fd.get('name'), scopes });
      const origin = location.origin;
      form.querySelector('.modal-title').textContent = 'Token criado';
      form.querySelector('.modal-body').replaceChildren(
        h('div', { class: 'alert alert-warning' }, 'Copie o token agora. Por segurança, ', h('strong', {}, 'não volta a ser mostrado'), '.'),
        h('pre', { class: 'user-select-all' }, t.token),
        h('div', { class: 'form-label' }, 'Windows (PowerShell, como administrador)'),
        h('pre', {}, `iwr ${origin}/agent/inventario.ps1 -OutFile inventario.ps1\npowershell -ExecutionPolicy Bypass -File inventario.ps1 -Servidor ${origin} -Token ${t.token}`),
        h('div', { class: 'form-label' }, 'Linux / macOS (como root, para obter o nº de série)'),
        h('pre', { class: 'mb-0' }, `curl -fsSL ${origin}/agent/inventario.sh | sudo sh -s -- -s ${origin} -t ${t.token}`));
      form.querySelector('.modal-footer').replaceChildren(
        h('button', { type: 'button', class: 'primary', onclick: () => { form.closest('dialog').close(); render(); } }, 'Concluído'));
      return true;
    }, { submitLabel: 'Criar token', wide: true });
}

// ======================================================================= conector Microsoft 365 / Azure
export async function connectorCard(c) {
  const con = await GET(`/api/clients/${c.id}/connector`);
  const content = [];
  if (con) {
    const st = L.syncStatus[con.last_status];
    const rep = con.last_report;
    const line = (label, r) => (r ? h('li', {}, `${label}: ${r.created} novos, ${r.updated} atualizados, ${r.unchanged} sem alterações${r.retired ? `, ${r.retired} abatidos` : ''}`) : null);
    content.push(details([
      ['Tenant', h('span', { class: 'font-monospace small' }, con.tenant_id)],
      ['Origens', [con.options.licenses && 'Licenças M365', con.options.intune && 'Dispositivos Intune', con.options.azure && 'Recursos Azure'].filter(Boolean).join(', ')],
      ['Sincronização diária', con.enabled ? badge('Ativa', 'ok') : badge('Desativada')],
      ['Última sincronização', con.last_sync ? [fmtDateTime(con.last_sync), ' ', st ? badge(st[0], st[1]) : null] : 'Nunca'],
    ]));
    if (rep) {
      content.push(h('ul', { class: 'small mt-3 mb-0 ps-3' }, line('Licenças', rep.licencas), line('Dispositivos', rep.dispositivos), line('Azure', rep.azure),
        rep.erros.map((e) => h('li', { class: 'text-danger' }, e))));
    }
  } else {
    content.push(h('p', { class: 'text-secondary mb-0' }, 'Importa automaticamente as licenças Microsoft 365, os dispositivos geridos pelo Intune e os recursos Azure deste cliente.'));
  }
  const syncBtn = con ? h('button', {
    class: 'btn-sm',
    onclick: async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      b.textContent = 'A sincronizar…';
      try {
        const r = await api('POST', `/api/clients/${c.id}/connector/sync`);
        toast(r.status === 'ok' ? 'Sincronização concluída.' : 'Sincronização com erros. Veja os detalhes no cartão.', r.status !== 'ok');
        render();
      } catch (ex) {
        toast(ex.message, true);
        b.disabled = false;
        b.textContent = 'Sincronizar agora';
      }
    },
  }, 'Sincronizar agora') : null;
  return card('Microsoft 365 / Azure', content,
    { actions: [syncBtn, h('button', { class: 'btn-sm', onclick: () => connectorDialog(c, con) }, icon('cloud'), con ? 'Configurar' : 'Ligar')] });
}

export function connectorDialog(c, con) {
  const o = con ? con.options : { licenses: true, intune: true, azure: false };
  const chk = (name, label, checked) => check(h('input', { type: 'checkbox', name, checked }), label);
  openDialog(`Microsoft 365 / Azure — ${c.name}`, [
    h('details', { class: 'mb-3' }, h('summary', { class: 'text-secondary' }, 'Como preparar o acesso no tenant do cliente'),
      h('ol', { class: 'small mt-2' },
        h('li', {}, 'Entra ID → App registrations → New registration (single tenant).'),
        h('li', {}, 'Certificates & secrets → New client secret. Copie o valor.'),
        h('li', {}, 'API permissions → Microsoft Graph → Application: Organization.Read.All (licenças) e DeviceManagementManagedDevices.Read.All (Intune). Clique "Grant admin consent".'),
        h('li', {}, 'Azure: em cada subscrição, Access control (IAM) → atribuir a função "Reader" à aplicação.'))),
    field('Tenant ID ou domínio', h('input', { name: 'tenant_id', required: true, value: con?.tenant_id, placeholder: 'contoso.onmicrosoft.com' })),
    field('Application (client) ID', h('input', { name: 'app_id', required: true, value: con?.app_id, placeholder: '00000000-0000-0000-0000-000000000000' })),
    field(con ? 'Client secret (vazio = manter o atual)' : 'Client secret', h('input', { name: 'secret', type: 'password', required: !con, autocomplete: 'off' })),
    h('div', { class: 'mb-3' },
      chk('licenses', 'Licenças Microsoft 365', o.licenses), chk('intune', 'Dispositivos Intune', o.intune),
      chk('azure', 'Recursos Azure', o.azure), chk('enabled', 'Sincronização automática diária', con ? con.enabled : true)),
    con ? h('button', {
      type: 'button', class: 'link text-danger',
      onclick: async (e) => {
        const dlg = e.currentTarget.closest('dialog');
        if (await confirmDialog('Remover conector', 'Remover o conector? Os ativos já importados mantêm-se.', 'Remover')) {
          await api('DELETE', `/api/clients/${c.id}/connector`);
          dlg.close();
          toast('Conector removido.');
          render();
        }
      },
    }, 'Remover conector') : null],
  async (fd) => {
    await api('PUT', `/api/clients/${c.id}/connector`, {
      tenant_id: fd.get('tenant_id'), app_id: fd.get('app_id'), secret: fd.get('secret') || undefined, enabled: fd.get('enabled') === 'on',
      options: { licenses: fd.get('licenses') === 'on', intune: fd.get('intune') === 'on', azure: fd.get('azure') === 'on' },
    });
    toast('Conector guardado. Use "Sincronizar agora" para testar a ligação.');
    render();
  }, { wide: true });
}

// ======================================================================= mapa de relações
export function graphLegend() {
  return h('p', { class: 'text-secondary small mt-3 mb-0' },
    'As setas vão de quem depende para a dependência (ex.: aplicação → servidor). A barra lateral indica a criticidade: ',
    badge('Crítica', 'danger'), ' ', badge('Alta', 'warn'), ' ', badge('Média', 'info'), ' ', badge('Baixa'), '. Clique num ativo para o abrir.');
}

export async function viewClientMap(id) {
  const [c, g] = await Promise.all([GET(`/api/clients/${id}`), GET(`/api/clients/${id}/graph`)]);
  setPage(
    pageHead({ title: 'Mapa de relações', crumbs: [['Clientes', '#/clientes'], [c.name, `#/clientes/${id}`]] },
      `${g.nodes.length} ativo(s) com relações · ${g.edges.length} relação(ões)`,
      h('a', { class: 'btn', href: `#/clientes/${id}` }, 'Voltar ao cliente')),
    g.truncated ? h('div', { class: 'alert alert-info' }, 'Este cliente tem muitos ativos relacionados: o mapa mostra os primeiros 800. Abra um ativo para ver o mapa centrado nele.') : null,
    card(null, [Graph.render(g, { relLabels: L.rel }), graphLegend()]));
}

export function ciMapCard(ci) {
  const holder = h('div', {}, h('p', { class: 'text-secondary' }, 'A carregar…'));
  const sel = select('depth', [[1, '1 nível'], [2, '2 níveis'], [3, '3 níveis'], [4, '4 níveis']], 2,
    { onchange: () => load(), 'aria-label': 'Profundidade do mapa', class: 'form-select-sm w-auto' });
  async function load() {
    try {
      const g = await GET(`/api/cis/${ci.id}/graph?depth=${sel.value}`);
      holder.replaceChildren(Graph.render(g, { centerId: ci.id, relLabels: L.rel }));
    } catch (e) {
      holder.replaceChildren(h('div', { class: 'alert alert-danger' }, e.message));
    }
  }
  load();
  return card('Mapa de relações', [holder, graphLegend()], { actions: sel });
}
