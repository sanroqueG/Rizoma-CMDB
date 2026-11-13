/* SaaS: a minha organização (plano, utilização, exportação) e administração da plataforma (organizações). */
import { GET, ME, api, badge, card, check, confirmDialog, details, field, fmtDate, h, icon, isAdmin, openDialog, select, table, toast } from '../core.js';
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
        h('p', { class: 'text-secondary small mt-3 mb-0' }, 'A exportação inclui clientes, locais, ativos, relações, contratos, tickets, utilizadores (sem passwords) e auditoria, num ficheiro JSON.')])),
      h('div', { class: 'col-12' }, await ssoCard()),
      ME.is_platform ? null : h('div', { class: 'col-lg-6' }, await supportCard()),
      ME.is_platform ? null : h('div', { class: 'col-lg-6' }, await deletionCard())));
}

/** Autorizar a equipa do Rizoma a entrar na organização para dar suporte. */
async function supportCard() {
  const s = await GET('/api/org/support-access');
  const set = async (hours) => {
    await api('PUT', '/api/org/support-access', { hours });
    toast(hours ? 'Acesso de suporte autorizado.' : 'Acesso de suporte revogado.');
    render();
  };
  return card('Acesso de suporte', [
    h('p', { class: 'text-secondary' }, 'Permite à equipa de suporte do Rizoma entrar na organização como administrador, para ajudar a resolver um problema. Cada sessão dura no máximo 1 hora e fica na auditoria.'),
    s.granted
      ? [h('div', { class: 'alert alert-info' }, `Autorizado até ${fmtDate(s.until)}.`), h('button', { onclick: () => set(0) }, 'Revogar agora')]
      : h('div', { class: 'btn-list' }, h('button', { onclick: () => set(24) }, 'Autorizar por 24 horas'), h('button', { onclick: () => set(72) }, 'Por 3 dias')),
  ]);
}

/** RGPD: eliminar a organização e todos os dados (com prazo para desistir). */
async function deletionCard() {
  const d = await GET('/api/org/deletion');
  if (d.requested) {
    return card('Eliminação pedida', [
      h('div', { class: 'alert alert-danger' }, `Pedida por ${d.requested_by} em ${fmtDate(d.requested_at)}. A organização e todos os dados vão ser eliminados em ${fmtDate(d.delete_at)}.`),
      h('div', { class: 'btn-list' },
        h('a', { class: 'btn', href: '/api/org/export', download: '' }, icon('download'), 'Exportar os dados antes'),
        h('button', { class: 'primary', onclick: async () => {
          await api('DELETE', '/api/org/deletion');
          ME.org_delete_at = null;
          toast('Eliminação cancelada.');
          render();
        } }, 'Desistir da eliminação')),
    ]);
  }
  return card('Eliminar a organização', [
    h('p', { class: 'text-secondary' }, `Apaga a organização e todos os dados: clientes, ativos, contratos, tickets, utilizadores e auditoria. Durante ${d.grace_days} dias a organização fica só de leitura e pode desistir; depois, a eliminação é definitiva. Exporte os dados antes, se precisar deles. A subscrição é cancelada no fim do período pago.`),
    h('button', { class: 'btn-outline-danger', onclick: async () => {
      const o = await GET('/api/org');
      openDialog('Eliminar a organização', h('div', {},
        h('p', {}, 'Para confirmar, escreva o identificador da organização: ', h('code', {}, o.slug)),
        field('Identificador', h('input', { name: 'confirm', required: true, autocomplete: 'off' }))),
      async (fd) => {
        const r = await api('POST', '/api/org/deletion', { confirm: fd.get('confirm') });
        ME.org_delete_at = r.delete_at;
        toast('Eliminação pedida.');
        render();
      }, { danger: true, submitLabel: 'Pedir a eliminação' });
    } }, icon('trash'), 'Eliminar a organização…'),
  ]);
}

/** Login único (SSO) da organização: Microsoft Entra ID, Google Workspace, Okta, Keycloak... */
async function ssoCard() {
  const s = await GET('/api/org/sso');
  const status = !s.configured ? badge('Não configurado') : s.enabled ? badge('Ativo', 'ok') : badge('Desligado', 'warn');
  const configure = () => openDialog('Login único (SSO)', h('div', { class: 'row' },
    h('div', { class: 'col-12 mb-3' }, h('div', { class: 'alert alert-info mb-0' },
      'Registe o Rizoma como aplicação no seu fornecedor de identidade (OpenID Connect) com este URL de redirecionamento:',
      h('div', { class: 'mt-1' }, h('code', {}, s.redirect_uri)))),
    field('Nome no botão', h('input', { name: 'label', value: s.label, placeholder: 'Ex.: Microsoft' }), 'col-md-6'),
    field('Emissor (issuer)', h('input', { name: 'issuer', required: true, value: s.issuer, placeholder: 'https://login.microsoftonline.com/<tenant>/v2.0' }), 'col-md-6'),
    field('Client ID', h('input', { name: 'client_id', required: true, value: s.client_id, autocomplete: 'off' }), 'col-md-6'),
    field(s.has_secret ? 'Client secret (deixe vazio para manter)' : 'Client secret', h('input', { name: 'client_secret', type: 'password', autocomplete: 'new-password' }), 'col-md-6'),
    h('div', { class: 'col-12 mb-3' }, h('label', { class: 'form-label' }, 'Domínios de email'),
      h('input', { name: 'domains', required: true, value: s.domains.join(', '), placeholder: 'empresa.pt, empresa.com' }),
      h('div', { class: 'form-hint' }, 'Quem escrever um email destes domínios no login é encaminhado para este fornecedor. Separe por vírgulas.')),
    h('div', { class: 'col-12' },
      check(h('input', { type: 'checkbox', name: 'enabled', checked: !s.configured || s.enabled }), 'SSO ativo'),
      check(h('input', { type: 'checkbox', name: 'auto_provision', checked: s.auto_provision }),
        'Criar utilizadores no primeiro login (como técnicos, sem acesso a clientes até um administrador os atribuir)'),
      check(h('input', { type: 'checkbox', name: 'enforce', checked: s.enforce }),
        'Obrigar ao SSO (só os administradores podem continuar a entrar com password, como acesso de emergência)'))),
  async (fd) => {
    await api('PUT', '/api/org/sso', {
      label: fd.get('label'), issuer: fd.get('issuer'), client_id: fd.get('client_id'),
      client_secret: fd.get('client_secret') || undefined,
      domains: String(fd.get('domains')).split(/[\s,;]+/).filter(Boolean),
      enabled: fd.get('enabled') === 'on', auto_provision: fd.get('auto_provision') === 'on', enforce: fd.get('enforce') === 'on',
    });
    toast('Configuração de SSO guardada.');
    render();
  }, { wide: true });
  return card('Login único (SSO)', [
    h('div', { class: 'd-flex align-items-start gap-3 flex-wrap' },
      h('div', { class: 'flex-fill' },
        h('p', { class: 'text-secondary' }, 'Os utilizadores entram com a conta da empresa (Microsoft Entra ID, Google Workspace, Okta, Keycloak ou outro fornecedor OpenID Connect).'),
        s.configured ? details([['Estado', status], ['Fornecedor', s.issuer], ['Domínios', s.domains.join(', ')],
          ['Criar utilizadores', s.auto_provision ? 'Sim' : 'Não'], ['SSO obrigatório', s.enforce ? 'Sim' : 'Não']]) : status),
      h('div', { class: 'btn-list' },
        h('button', { class: 'primary', onclick: configure }, icon('key'), s.configured ? 'Alterar' : 'Configurar'),
        s.configured ? h('button', { onclick: async () => {
          const r = await api('POST', '/api/org/sso/test');
          toast(r.ok ? `Ligação ao fornecedor OK (${r.issuer}).` : `Falhou: ${r.error}`, !r.ok);
        } }, 'Testar ligação') : null,
        s.configured ? h('button', { class: 'text-danger', onclick: async () => {
          if (await confirmDialog('Remover SSO', 'Remover a configuração de login único? Os utilizadores voltam a entrar com password (quem não tiver password terá de a recuperar por email).', 'Remover')) {
            await api('DELETE', '/api/org/sso'); toast('SSO removido.'); render();
          }
        } }, 'Remover') : null)),
  ]);
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
          o.support_until && o.id !== ME.org_id ? [h('button', { class: 'link', title: `Autorizado até ${fmtDate(o.support_until)}`, onclick: async () => {
            if (await confirmDialog('Entrar como suporte', `Entrar em "${o.name}" como administrador, durante no máximo 1 hora? A sessão atual termina e tudo fica na auditoria da organização.`, 'Entrar')) {
              await api('POST', `/api/platform/orgs/${o.id}/support-session`);
              location.hash = '#/';
              location.reload();
            }
          } }, 'Entrar (suporte)'), ' · '] : null,
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
