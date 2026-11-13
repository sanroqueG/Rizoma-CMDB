/* Administração: utilizadores e auditoria. */
import { GET, L, ME, META, api, badge, card, check, confirmDialog, dash, field, fmtDateTime, getClients, h, icon, isAdmin, openDialog, select, setMETA, table, toast } from '../core.js';
import { pageHead, render, setPage } from '../main.js';

// ======================================================================= utilizadores
export async function viewUsers() {
  if (!isAdmin()) throw new Error('Apenas administradores.');
  const [users, clients] = await Promise.all([GET('/api/users'), getClients(true)]);
  const cname = Object.fromEntries(clients.map((c) => [c.id, c.name]));
  const initials = (n) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  setPage(
    pageHead('Utilizadores', `${users.length} utilizador(es)`, h('div', { class: 'btn-list' },
      h('button', { onclick: () => userDialog(null, clients) }, icon('plus'), 'Criar com password'),
      h('button', { class: 'primary', onclick: () => inviteDialog(clients) }, icon('mail'), 'Convidar por email'))),
    card(null, table(['Utilizador', 'Perfil', 'Acesso a clientes', '2FA', 'Estado', ''],
      users.map((u) => h('tr', {},
        h('td', {}, h('div', { class: 'd-flex align-items-center gap-2' }, h('span', { class: 'avatar avatar-sm bg-secondary-lt' }, initials(u.name)),
          h('div', {}, h('div', {}, u.name), h('div', { class: 'text-secondary small' }, u.email ? `${u.username} · ${u.email}` : u.username)))),
        h('td', {}, L.role[u.role]),
        h('td', { class: 'text-secondary' }, u.role === 'admin' ? 'Todos'
          : u.role === 'client' ? cname[u.client_id] || '—'
            : u.client_ids.length ? u.client_ids.map((id) => cname[id]).filter(Boolean).join(', ') : 'Nenhum'),
        h('td', {}, u.totp_enabled ? badge('Ativo', 'ok') : h('span', { class: 'text-secondary' }, '—')),
        h('td', {}, u.invite_pending ? badge('Convite pendente', 'warn') : u.active ? badge('Ativo', 'ok') : badge('Inativo'),
          !u.invite_pending && u.must_change_password ? [' ', badge('Mudar password', 'warn')] : null),
        h('td', { class: 'text-end text-nowrap' },
          u.invite_pending ? [h('button', { class: 'link', onclick: async () => {
            showInviteResult(await api('POST', `/api/users/${u.id}/invite/resend`), u.email);
          } }, 'Reenviar convite'), ' · '] : null,
          h('button', { class: 'link', onclick: () => userDialog(u, clients) }, 'Editar'),
          u.id !== ME.id ? [' · ', h('button', { class: 'link text-danger', onclick: async () => {
            if (await confirmDialog('Eliminar utilizador', `Eliminar o utilizador "${u.username}"?`)) {
              await api('DELETE', `/api/users/${u.id}`); toast('Utilizador eliminado.'); render();
            }
          } }, 'Eliminar')] : null))))));
}

/** Mostra o resultado de um convite: confirmação, ou a ligação a entregar quando não há email configurado. */
function showInviteResult(r, email) {
  if (r.email_sent) { toast(`Convite enviado para ${email}.`); render(); return; }
  const input = h('input', { readonly: true, value: r.invite_url, onfocus: (e) => e.currentTarget.select() });
  openDialog('Convite criado', h('div', {},
    h('p', {}, 'O envio de email não está configurado neste servidor. Entregue esta ligação ao utilizador por outro meio (é válida durante 7 dias e só pode ser usada uma vez):'),
    input,
    h('button', { type: 'button', class: 'mt-2', onclick: async () => { await navigator.clipboard.writeText(r.invite_url); toast('Ligação copiada.'); } }, icon('link'), 'Copiar ligação')),
  async () => { render(); }, { submitLabel: 'Fechar' });
}

/** Convite por email: o utilizador escolhe a própria password ao aceitar. */
function inviteDialog(clients) {
  const roleSel = select('role', META.roles.map((r) => [r, L.role[r]]), 'tech');
  const clientField = field('Cliente associado', select('client_id', [['', '— escolher —'], ...clients.map((c) => [c.id, c.name])], ''), 'col-12');
  const techField = field('Clientes a que tem acesso', h('div', { class: 'border rounded p-2 checks-scroll' },
    clients.length ? clients.map((c) => check(h('input', { type: 'checkbox', name: 'client_ids', value: c.id }), c.name, 'mb-1'))
      : h('span', { class: 'text-secondary' }, 'Não existem clientes.')), 'col-12');
  const sync = () => { clientField.hidden = roleSel.value !== 'client'; techField.hidden = roleSel.value !== 'tech'; };
  roleSel.addEventListener('change', sync);
  sync();
  openDialog('Convidar por email', h('div', { class: 'row' },
    h('p', { class: 'text-secondary col-12' }, 'A pessoa recebe um email com uma ligação para definir a sua password. O email passa a ser o nome de utilizador.'),
    field('Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'off' }), 'col-md-6'),
    field('Nome', h('input', { name: 'name', required: true }), 'col-md-6'),
    field('Perfil', roleSel, 'col-md-6'),
    clientField, techField),
  async (fd) => {
    const body = { email: fd.get('email'), name: fd.get('name'), role: fd.get('role') };
    if (body.role === 'client') body.client_id = Number(fd.get('client_id')) || undefined;
    if (body.role === 'tech') body.client_ids = fd.getAll('client_ids').map(Number);
    showInviteResult(await api('POST', '/api/users/invite', body), body.email);
  }, { wide: true, submitLabel: 'Enviar convite' });
}

export function userDialog(u, clients) {
  const roleSel = select('role', META.roles.map((r) => [r, L.role[r]]), u?.role ?? 'tech');
  const clientField = field('Cliente associado', select('client_id', [['', '— escolher —'], ...clients.map((c) => [c.id, c.name])], u?.client_id ?? ''), 'col-12');
  const techField = field('Clientes a que tem acesso', h('div', { class: 'border rounded p-2 checks-scroll' },
    clients.length ? clients.map((c) => check(h('input', { type: 'checkbox', name: 'client_ids', value: c.id, checked: u?.client_ids.includes(c.id) }), c.name, 'mb-1'))
      : h('span', { class: 'text-secondary' }, 'Não existem clientes.')), 'col-12');
  const sync = () => {
    clientField.hidden = roleSel.value !== 'client';
    techField.hidden = roleSel.value !== 'tech';
  };
  roleSel.addEventListener('change', sync);
  sync();
  openDialog(u ? `Editar ${u.username}` : 'Novo utilizador', h('div', { class: 'row' },
    field('Utilizador', h('input', { name: 'username', required: true, value: u?.username, disabled: !!u, autocomplete: 'off' }), 'col-md-6'),
    field('Nome', h('input', { name: 'name', required: true, value: u?.name }), 'col-md-6'),
    field('Email' + (META.sso ? ' (usado no login SSO)' : ''), h('input', { name: 'email', type: 'email', value: u?.email }), 'col-md-6'),
    field('Perfil', roleSel, 'col-md-6'),
    h('div', { class: 'col-12 mb-3' },
      h('label', { class: 'form-label' }, u ? 'Nova password (opcional)' : META.sso ? 'Password (opcional com SSO)' : 'Password'),
      h('input', { name: 'password', type: 'password', minlength: 10, required: !u && !META.sso, autocomplete: 'new-password' }),
      h('div', { class: 'form-hint' }, 'Mínimo de 10 caracteres, com pelo menos dois tipos (minúsculas, maiúsculas, números ou símbolos). Passwords comuns são recusadas.')),
    clientField, techField,
    h('div', { class: 'col-12' },
      check(h('input', { type: 'checkbox', name: 'must_change_password', checked: u ? u.must_change_password : true }), 'Obrigar a mudar a password no próximo login'),
      u ? check(h('input', { type: 'checkbox', name: 'active', checked: u.active }), 'Conta ativa') : null),
    u && u.totp_enabled ? h('div', { class: 'col-12 mt-2' }, h('button', {
      type: 'button', class: 'link text-danger',
      onclick: async (e) => {
        const dlg = e.currentTarget.closest('dialog');
        if (await confirmDialog('Repor 2FA', `Desativar a autenticação de dois fatores de "${u.username}"? Use isto se o utilizador perdeu o telemóvel e os códigos de recuperação.`, 'Repor 2FA')) {
          await api('POST', `/api/users/${u.id}/2fa/reset`);
          dlg.close();
          toast('2FA reposto. O utilizador terá de o configurar de novo.');
          render();
        }
      },
    }, 'Repor autenticação de dois fatores')) : null),
  async (fd) => {
    const body = { name: fd.get('name'), role: fd.get('role'), email: fd.get('email') };
    if (!u) body.username = fd.get('username');
    if (fd.get('password')) body.password = fd.get('password');
    if (body.role === 'client') body.client_id = fd.get('client_id') || null;
    if (body.role === 'tech') body.client_ids = fd.getAll('client_ids').map(Number);
    if (u) body.active = fd.get('active') === 'on';
    body.must_change_password = fd.get('must_change_password') === 'on';
    if (u) await api('PUT', `/api/users/${u.id}`, body); else await api('POST', '/api/users', body);
    toast('Utilizador guardado.');
    render();
  }, { wide: true });
}

// ======================================================================= tipos de ativo
export async function viewTypes() {
  if (!isAdmin()) throw new Error('Apenas administradores.');
  const types = await GET('/api/types');
  const own = types.filter((t) => !t.builtin);
  const refresh = async (msg) => { setMETA(await GET('/api/meta')); toast(msg); render(); };
  const typeDialog = (t) => openDialog(t ? `Editar ${t.name}` : 'Novo tipo de ativo', h('div', { class: 'row' },
    field('Nome', h('input', { name: 'name', required: true, maxlength: 60, value: t?.name, placeholder: 'Ex.: Câmara IP' }), 'col-md-6'),
    field('Categoria', h('input', { name: 'category', required: true, maxlength: 40, value: t?.category, list: 'type-categories', placeholder: 'Ex.: Hardware' }), 'col-md-6'),
    h('datalist', { id: 'type-categories' }, [...new Set(types.map((x) => x.category))].map((c) => h('option', { value: c }))),
    h('div', { class: 'col-12 mb-3' }, h('label', { class: 'form-label' }, 'Campos próprios'),
      h('input', { name: 'fields', value: t?.fields.join(', '), placeholder: 'resolucao, firmware, ip_gestao' }),
      h('div', { class: 'form-hint' }, 'Atributos que aparecem no formulário dos ativos deste tipo. Separe por vírgulas; letras minúsculas, números e _.'))),
  async (fd) => {
    const body = { name: fd.get('name'), category: fd.get('category'), fields: String(fd.get('fields')).split(/[,;]+/).map((x) => x.trim()).filter(Boolean) };
    if (t) await api('PUT', `/api/types/${t.id}`, body); else await api('POST', '/api/types', body);
    await refresh('Tipo guardado.');
  }, { wide: true });
  const row = (t) => h('tr', {},
    h('td', {}, t.name, t.builtin ? [' ', badge('Base')] : null),
    h('td', { class: 'text-secondary' }, t.category),
    h('td', { class: 'text-secondary' }, t.fields.length ? t.fields.join(', ') : '—'),
    h('td', { class: 'num' }, String(t.cis)),
    h('td', { class: 'text-end text-nowrap' }, t.builtin ? null : [
      h('button', { class: 'link', onclick: () => typeDialog(t) }, 'Editar'), ' · ',
      h('button', { class: 'link text-danger', onclick: async () => {
        if (await confirmDialog('Eliminar tipo', `Eliminar o tipo "${t.name}"?`)) { await api('DELETE', `/api/types/${t.id}`); await refresh('Tipo eliminado.'); }
      } }, 'Eliminar')]));
  const cols = ['Tipo', 'Categoria', 'Campos', { label: 'Ativos', cls: 'num' }, ''];
  setPage(
    pageHead('Tipos de ativo', `${own.length} próprio(s) · ${types.length - own.length} base`,
      h('button', { class: 'primary', onclick: () => typeDialog(null) }, icon('plus'), 'Novo tipo')),
    card('Tipos da organização', own.length ? table(cols, own.map(row))
      : h('p', { class: 'text-secondary mb-0' }, 'Ainda não criou tipos próprios. Crie um quando os tipos base não descreverem bem um equipamento ou serviço dos seus clientes (ex.: câmara IP, UPS, licença de software).')),
    card('Tipos base', [h('p', { class: 'text-secondary' }, 'Comuns a todas as organizações e usados pelos agentes de inventário e pelos conectores cloud. Não podem ser alterados.'),
      table(cols, types.filter((t) => t.builtin).map(row))]));
}

// ======================================================================= auditoria
export async function viewAudit(query) {
  if (!isAdmin()) throw new Error('Apenas administradores.');
  const entity = query.get('entity') || '';
  const PAGE = 200;
  const url = (before) => `/api/audit?limit=${PAGE}${entity ? `&entity=${encodeURIComponent(entity)}` : ''}${before ? `&before=${before}` : ''}`;
  const rows = await GET(url());
  const row = (a) => h('tr', {},
    h('td', { class: 'text-secondary text-nowrap' }, fmtDateTime(a.created_at)), h('td', {}, a.actor), h('td', {}, L.action[a.action] || a.action),
    h('td', {}, badge(L.entity[a.entity] || a.entity)),
    h('td', {}, a.entity === 'ci' && a.action !== 'delete' ? h('a', { href: `#/ativos/${a.entity_id}` }, a.label) : dash(a.label && a.label.replace(/#\d+# /g, ''))),
    h('td', { class: 'text-secondary' }, dash(a.client_name)));
  const body = table(['Quando', 'Quem', 'Ação', 'Entidade', 'Registo', 'Cliente'], rows.map(row), 'Sem eventos.');
  let lastId = rows.length ? rows[rows.length - 1].id : null;
  const more = rows.length === PAGE ? h('div', { class: 'card-footer text-center' }, h('button', { onclick: async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    const next = await GET(url(lastId));
    body.querySelector('tbody').append(...next.map(row));
    lastId = next.length ? next[next.length - 1].id : lastId;
    b.disabled = false;
    if (next.length < PAGE) b.parentElement.remove();
  } }, 'Carregar mais')) : null;
  setPage(
    pageHead('Auditoria', 'Eventos da organização, do mais recente para o mais antigo',
      select('entity', [['', 'Todas as entidades'], ...Object.entries(L.entity)], entity,
        { onchange: (e) => { location.hash = e.target.value ? `#/auditoria?entity=${e.target.value}` : '#/auditoria'; }, 'aria-label': 'Entidade' })),
    h('div', { class: 'card' }, body, more));
}
