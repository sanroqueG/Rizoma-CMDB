/* SaaS: a minha organização (plano, utilização, exportação) e administração da plataforma (organizações). */
import { GET, ME, api, badge, card, details, field, fmtDate, h, icon, isAdmin, openDialog, select, table, toast } from '../core.js';
import { pageHead, render, setPage } from '../main.js';

export const PLAN_LABEL = { clients: 'Clientes', cis: 'Ativos', users: 'Utilizadores' };

/** Barra de utilização face ao limite do plano. */
export function usageBar(label, used, max) {
  const pct = max ? Math.min(100, Math.round((used / max) * 100)) : null;
  return h('div', { class: 'mb-3' },
    h('div', { class: 'd-flex mb-1' }, h('span', {}, label), h('span', { class: 'ms-auto text-secondary' }, max ? `${used} de ${max}` : `${used} · sem limite`)),
    h('div', { class: 'progress progress-sm' },
      h('div', { class: `progress-bar ${pct !== null && pct >= 90 ? 'bg-red' : 'bg-primary'}`, style: { width: `${pct ?? 0}%` }, role: 'progressbar' })));
}

export async function viewOrganization() {
  if (!isAdmin()) throw new Error('Apenas administradores.');
  const o = await GET('/api/org');
  setPage(
    pageHead('Organização', `${o.name} · plano ${o.plan}`,
      h('a', { class: 'btn', href: '/api/org/export', download: '' }, icon('download'), 'Exportar todos os dados'),
      h('button', { class: 'primary', onclick: () => openDialog('Nome da organização', field('Nome', h('input', { name: 'name', required: true, value: o.name })),
        async (fd) => { await api('PUT', '/api/org', { name: fd.get('name') }); toast('Organização atualizada.'); render(); }) }, icon('edit'), 'Mudar o nome')),
    h('div', { class: 'row row-cards' },
      h('div', { class: 'col-lg-6' }, card('Utilização do plano', [
        usageBar(PLAN_LABEL.clients, o.usage.clients, o.max_clients),
        usageBar(PLAN_LABEL.cis, o.usage.cis, o.max_cis),
        usageBar(PLAN_LABEL.users, o.usage.users, o.max_users),
        h('p', { class: 'text-secondary small mb-0' }, 'Para alterar os limites do plano, contacte o suporte.')])),
      h('div', { class: 'col-lg-6' }, card('Dados da organização', [
        details([['Nome', o.name], ['Identificador', h('code', {}, o.slug)], ['Plano', o.plan], ['Criada em', fmtDate(o.created_at)]]),
        h('p', { class: 'text-secondary small mt-3 mb-0' }, 'A exportação inclui clientes, locais, ativos, relações, contratos, tickets, utilizadores (sem passwords) e auditoria, num ficheiro JSON.')]))));
}

// ======================================================================= plataforma
export async function viewPlatform() {
  if (!ME.is_platform) throw new Error('Apenas administradores da plataforma.');
  const orgs = await GET('/api/platform/orgs');
  const lim = (used, max) => (max ? `${used} / ${max}` : String(used));
  setPage(
    pageHead('Plataforma', `${orgs.length} organização(ões)`, h('button', { class: 'primary', onclick: () => orgDialog() }, icon('plus'), 'Nova organização')),
    card(null, table(['Organização', 'Plano', 'Estado', { label: 'Clientes', cls: 'num' }, { label: 'Ativos', cls: 'num' }, { label: 'Utilizadores', cls: 'num' }, 'Criada', ''],
      orgs.map((o) => h('tr', {},
        h('td', {}, o.name, h('div', { class: 'text-secondary small' }, o.slug)),
        h('td', {}, o.plan),
        h('td', {}, o.status === 'active' ? badge('Ativa', 'ok') : badge('Suspensa', 'danger')),
        h('td', { class: 'text-end' }, lim(o.usage.clients, o.max_clients)),
        h('td', { class: 'text-end' }, lim(o.usage.cis, o.max_cis)),
        h('td', { class: 'text-end' }, lim(o.usage.users, o.max_users)),
        h('td', { class: 'text-secondary' }, fmtDate(o.created_at)),
        h('td', { class: 'text-end text-nowrap' },
          h('button', { class: 'link', onclick: () => orgDialog(o) }, 'Editar'),
          o.id !== ME.org_id ? [' · ', h('button', { class: 'link text-danger', onclick: () => deleteOrgDialog(o) }, 'Eliminar')] : null))),
      'Sem organizações.')));
}

export function orgDialog(o) {
  const limits = h('div', { class: 'row' },
    field('Máx. clientes', h('input', { name: 'max_clients', type: 'number', min: 0, value: o?.max_clients ?? '', placeholder: 'sem limite' }), 'col-md-4'),
    field('Máx. ativos', h('input', { name: 'max_cis', type: 'number', min: 0, value: o?.max_cis ?? '', placeholder: 'sem limite' }), 'col-md-4'),
    field('Máx. utilizadores', h('input', { name: 'max_users', type: 'number', min: 0, value: o?.max_users ?? '', placeholder: 'sem limite' }), 'col-md-4'));
  const fields = o ? [
    h('div', { class: 'row' },
      field('Nome', h('input', { name: 'name', required: true, value: o.name }), 'col-md-6'),
      field('Plano', h('input', { name: 'plan', required: true, value: o.plan }), 'col-md-3'),
      field('Estado', select('status', [['active', 'Ativa'], ['suspended', 'Suspensa']], o.status, { disabled: o.id === ME.org_id }), 'col-md-3')),
    limits,
    h('p', { class: 'form-hint mb-0' }, 'Suspender termina de imediato as sessões dos utilizadores dessa organização.')]
    : [
      h('div', { class: 'row' },
        field('Nome da organização', h('input', { name: 'name', required: true, placeholder: 'ex.: Acme Serviços de TI, Lda.' }), 'col-md-8'),
        field('Plano', h('input', { name: 'plan', value: 'standard', required: true }), 'col-md-4')),
      limits,
      h('h3', { class: 'card-title mt-2 mb-3' }, 'Primeiro administrador'),
      h('div', { class: 'row' },
        field('Nome', h('input', { name: 'admin_name', required: true }), 'col-md-6'),
        field('Email', h('input', { name: 'admin_email', type: 'email' }), 'col-md-6'),
        field('Utilizador', h('input', { name: 'admin_username', required: true, autocomplete: 'off' }), 'col-md-6'),
        field('Password inicial', h('input', { name: 'admin_password', type: 'password', required: true, minlength: 10, autocomplete: 'new-password' }), 'col-md-6')),
      h('p', { class: 'form-hint mb-0' }, 'O administrador é obrigado a mudar a password no primeiro login.')];
  openDialog(o ? `Editar ${o.name}` : 'Nova organização', fields, async (fd) => {
    const body = Object.fromEntries(fd);
    if (o) await api('PUT', `/api/platform/orgs/${o.id}`, body); else await api('POST', '/api/platform/orgs', body);
    toast(o ? 'Organização atualizada.' : 'Organização criada.');
    render();
  }, { wide: true });
}

export function deleteOrgDialog(o) {
  openDialog('Eliminar organização', [
    h('div', { class: 'alert alert-danger' }, 'Elimina a organização ', h('strong', {}, o.name), ' e todos os seus clientes, ativos, contratos e utilizadores. Não pode ser anulada. Exporte os dados antes, se for preciso.'),
    field(`Escreva o identificador (${o.slug}) para confirmar`, h('input', { name: 'confirm', required: true, autocomplete: 'off' }))],
  async (fd) => {
    await api('DELETE', `/api/platform/orgs/${o.id}?confirm=${encodeURIComponent(fd.get('confirm'))}`);
    toast('Organização eliminada.');
    render();
  }, { submitLabel: 'Eliminar definitivamente', danger: true });
}
