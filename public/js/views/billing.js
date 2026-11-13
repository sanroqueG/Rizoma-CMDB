/* Subscrição da organização (Stripe): plano, período experimental, mudar de plano. */
import { GET, ME, api, badge, card, details, fmtDate, h, icon, isAdmin } from '../core.js';
import { pageHead, setPage } from '../main.js';

const STATUS = {
  trialing: ['Período experimental', 'info'], active: ['Ativa', 'ok'], past_due: ['Pagamento em atraso', 'warn'],
  canceled: ['Cancelada', 'danger'], unpaid: ['Por pagar', 'danger'], incomplete: ['Incompleta', 'warn'], incomplete_expired: ['Expirada', 'danger'],
};
const limitText = (n, label) => (n === null ? `${label} ilimitados` : `Até ${n.toLocaleString('pt-PT')} ${label}`);
const daysLeft = (iso) => Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 864e5));

/** Aviso no topo das páginas: dias de experiência que restam, ou modo só de leitura. */
export function billingBanner() {
  if (ME && ME.support_session) {
    return h('div', { class: 'alert alert-warning' }, `Sessão de suporte: ${ME.support_session.by} está a agir como ${ME.support_session.as}. Tudo fica registado na auditoria.`,
      h('a', { href: '/api/logout', class: 'alert-link ms-1', onclick: async (e) => { e.preventDefault(); await fetch('/api/logout', { method: 'POST' }); location.reload(); } }, 'Terminar'));
  }
  if (ME && ME.org_delete_at) {
    return h('div', { class: 'alert alert-danger' }, `A organização vai ser eliminada em ${fmtDate(ME.org_delete_at)}, com todos os dados. Até lá fica só de leitura.`,
      isAdmin() ? h('a', { href: '#/organizacao', class: 'alert-link ms-1' }, 'Desistir da eliminação') : null);
  }
  const b = ME && ME.billing;
  if (!b) return null;
  const link = isAdmin() ? h('a', { href: '#/subscricao', class: 'alert-link ms-1' }, 'Escolher um plano') : null;
  if (b.blocked) {
    return h('div', { class: 'alert alert-danger' }, `${b.blocked} A organização está em modo só de leitura: pode consultar e exportar os dados, mas não alterar.`, link);
  }
  if (b.status === 'trialing' && b.trial_ends_at) {
    const d = daysLeft(b.trial_ends_at);
    return d <= 7 ? h('div', { class: 'alert alert-info' }, `Período experimental: ${d === 1 ? 'falta 1 dia' : `faltam ${d} dias`}.`, link) : null;
  }
  if (b.status === 'past_due') return h('div', { class: 'alert alert-warning' }, 'O último pagamento falhou. Atualize o meio de pagamento para não perder o acesso.', link);
  return null;
}

export async function viewBilling(query) {
  if (!isAdmin()) throw new Error('Apenas administradores.');
  const b = await GET('/api/billing');
  const [label, tone] = STATUS[b.status] || ['Sem subscrição', null];
  const pay = async (plan) => { location.href = (await api('POST', '/api/billing/checkout', { plan })).url; };
  const portal = async () => { location.href = (await api('POST', '/api/billing/portal')).url; };

  if (b.managed) {
    setPage(pageHead('Subscrição'), card(null, h('p', { class: 'mb-0' },
      'A faturação desta organização é gerida diretamente pela equipa do Rizoma. Para mudar de plano ou de limites, contacte o suporte.')));
    return;
  }
  const subscribed = b.has_customer && ['active', 'past_due', 'trialing'].includes(b.status) && b.status !== 'trialing';
  setPage(
    pageHead('Subscrição', b.plan ? `Plano ${b.plan}` : '',
      b.has_customer ? h('button', { onclick: portal }, icon('external'), 'Gerir subscrição e faturas') : null),
    query.get('estado') === 'sucesso' ? h('div', { class: 'alert alert-success' }, 'Obrigado! A subscrição fica ativa assim que o pagamento for confirmado (normalmente, segundos).') : null,
    !b.enabled ? h('div', { class: 'alert alert-warning' }, 'Os pagamentos ainda não estão ativos neste servidor.') : null,
    card('Estado', details([
      ['Estado', badge(label, tone)],
      ['Plano', b.plan || '—'],
      b.status === 'trialing' && b.trial_ends_at ? ['Fim do período experimental', `${fmtDate(b.trial_ends_at)} (${daysLeft(b.trial_ends_at)} dias)`] : null,
      b.current_period_end ? ['Próxima renovação', fmtDate(b.current_period_end)] : null,
      b.cancel_at ? ['Termina em', fmtDate(b.cancel_at)] : null,
    ].filter(Boolean))),
    h('div', { class: 'row row-cards' }, b.plans.map((p) => h('div', { class: 'col-md-4' }, h('div', { class: 'card h-100' },
      h('div', { class: 'card-body d-flex flex-column' },
        h('h3', { class: 'card-title mb-3' }, p.label, b.plan === p.id ? [' ', badge('Atual', 'ok')] : null),
        h('ul', { class: 'list-unstyled text-secondary flex-fill' },
          h('li', {}, limitText(p.limits.max_clients, 'clientes')),
          h('li', {}, limitText(p.limits.max_cis, 'ativos')),
          h('li', {}, limitText(p.limits.max_users, 'utilizadores'))),
        subscribed ? null : p.available && b.enabled
          ? h('button', { class: 'primary w-100', onclick: () => pay(p.id) }, 'Subscrever')
          : h('a', { class: 'btn w-100', href: 'mailto:comercial@rizoma.pt' }, 'Falar com a equipa')))))),
    h('p', { class: 'text-secondary small' }, 'Pagamento seguro pelo Stripe (cartão, SEPA). A fatura com NIF é enviada por email em cada renovação.'));
}
