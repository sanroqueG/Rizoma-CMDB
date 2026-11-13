/* Integrações da organização: RMM (NinjaOne). */
import { GET, api, badge, card, check, confirmDialog, details, field, fmtDateTime, getClients, h, icon, isAdmin, openDialog, select, table, toast } from '../core.js';
import { pageHead, render, setPage } from '../main.js';

const REGION_LABEL = { eu: 'Europa (eu.ninjarmm.com)', us: 'EUA (app.ninjarmm.com)', us2: 'EUA 2 (us2.ninjarmm.com)', ca: 'Canadá (ca.ninjarmm.com)', oc: 'Oceânia (oc.ninjarmm.com)' };
const STATUS = { ok: ['OK', 'ok'], parcial: ['Parcial', 'warn'], erro: ['Erro', 'danger'] };

export async function viewIntegrations() {
  if (!isAdmin()) throw new Error('Apenas administradores.');
  const [n, clients, hooks, events] = await Promise.all([GET('/api/rmm'), getClients(true), GET('/api/webhooks'), GET('/api/webhooks/events')]);

  const configure = () => openDialog('NinjaOne', h('div', { class: 'row' },
    h('div', { class: 'col-12 mb-3' }, h('div', { class: 'alert alert-info mb-0' },
      'No NinjaOne: Administração → Apps → API → Client app IDs → adicionar uma aplicação "API Services (machine-to-machine)" com o âmbito Monitoring e a concessão Client Credentials. O Rizoma só lê dados.')),
    field('Região', select('region', n.regions.map((r) => [r, REGION_LABEL[r] || r]), n.region || 'eu'), 'col-md-6'),
    field('Client ID', h('input', { name: 'client_id', required: true, value: n.client_id || '', autocomplete: 'off' }), 'col-md-6'),
    field(n.configured ? 'Client secret (deixe vazio para manter)' : 'Client secret', h('input', { name: 'secret', type: 'password', required: !n.configured, autocomplete: 'new-password' }), 'col-12')),
  async (fd) => {
    const r = await api('PUT', '/api/rmm', { region: fd.get('region'), client_id: fd.get('client_id'), secret: fd.get('secret') || undefined });
    toast(r.test_error ? `Guardado, mas a ligação falhou: ${r.test_error}` : `Ligação OK: ${r.mapping.length} organizações no NinjaOne.`, !!r.test_error);
    render();
  }, { wide: true });

  const sync = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await api('POST', '/api/rmm/sync');
      toast(r.status === 'ok' ? 'Sincronização concluída.' : `Sincronização ${r.status}: ${r.report.erros[0] || ''}`, r.status !== 'ok');
      render();
    } finally { btn.disabled = false; }
  };

  const mappingTable = () => {
    const rows = n.mapping.map((m) => {
      const sel = select('client', [['', '— não sincronizar —'], ...clients.map((c) => [c.id, c.name])], m.client_id ?? '');
      sel.dataset.remote = m.remote_org_id;
      return h('tr', {}, h('td', {}, m.remote_org_name), h('td', { class: 'num' }, m.devices === null ? '—' : String(m.devices)), h('td', {}, sel));
    });
    const save = h('button', { class: 'primary', onclick: async () => {
      const items = [.../** @type {NodeListOf<HTMLSelectElement>} */ (document.querySelectorAll('select[data-remote]'))].map((s) => ({ remote_org_id: s.dataset.remote, client_id: Number(s.value) || undefined }));
      await api('PUT', '/api/rmm/mapping', { items });
      toast('Associações guardadas.');
      render();
    } }, 'Guardar associações');
    return [table(['Organização no NinjaOne', { label: 'Dispositivos', cls: 'num' }, 'Cliente no Rizoma'], rows, 'Sem organizações. Verifique a ligação.'),
      h('div', { class: 'mt-3' }, save)];
  };

  const rep = n.last_report;
  const [stLabel, stTone] = STATUS[n.last_status] || ['Nunca', null];
  setPage(
    pageHead('Integrações', 'RMM, avisos e webhooks'),
    card('NinjaOne', [
      h('p', { class: 'text-secondary' }, 'Importa os dispositivos geridos no NinjaOne para os clientes correspondentes: servidores, postos de trabalho, portáteis, máquinas virtuais e equipamentos de rede. Não duplica o que já veio dos agentes ou do Intune, e marca como abatidos os que deixarem de existir. Sincroniza automaticamente uma vez por dia.'),
      n.configured ? details([
        ['Região', REGION_LABEL[n.region] || n.region],
        ['Última sincronização', n.last_sync ? [fmtDateTime(n.last_sync), ' ', badge(stLabel, stTone)] : 'Nunca'],
        rep ? ['Resultado', Object.entries(rep.clientes).map(([c, x]) => `${c}: ${x.created} novos, ${x.updated} atualizados, ${x.retired} abatidos`).join(' · ') || '—'] : null,
        rep && rep.sem_cliente ? ['Por associar', `${rep.sem_cliente} dispositivo(s) de organizações sem cliente`] : null,
        rep && rep.erros.length ? ['Erros', rep.erros.slice(0, 3).join(' · ')] : null,
      ].filter(Boolean)) : badge('Não configurado'),
      h('div', { class: 'btn-list mt-3' },
        h('button', { class: n.configured ? '' : 'primary', onclick: configure }, icon('key'), n.configured ? 'Alterar credenciais' : 'Ligar ao NinjaOne'),
        n.configured ? h('button', { class: 'primary', onclick: sync }, icon('refresh'), 'Sincronizar agora') : null,
        n.configured ? h('button', { class: 'text-danger', onclick: async () => { await api('DELETE', '/api/rmm'); toast('Integração removida.'); render(); } }, 'Remover') : null),
    ]),
    n.configured ? card('Organizações do NinjaOne → clientes', [
      h('p', { class: 'text-secondary' }, 'Associe cada organização do NinjaOne a um cliente. As associações pelo nome são sugeridas automaticamente; confirme-as antes de sincronizar.'),
      ...mappingTable()]) : null,
    webhooksCard(hooks, events, clients));
}

// ======================================================================= avisos e webhooks
const KIND = { slack: 'Slack', teams: 'Microsoft Teams', generic: 'Webhook' };
const URL_HINT = {
  slack: 'No Slack: Apps → Incoming Webhooks → Add to Slack → escolher o canal. URL começado por https://hooks.slack.com/…',
  teams: 'No Teams: no canal, … → Workflows → "Post to a channel when a webhook request is received". Copie o URL gerado.',
  generic: 'Recebe um POST JSON por evento, assinado (cabeçalho X-Rizoma-Signature: t=…,v1=HMAC-SHA256 de "t.corpo").',
};

function webhookDialog(w, events, clients) {
  const kindSel = select('kind', Object.entries(KIND), w?.kind ?? 'slack', { disabled: !!w });
  const hint = h('div', { class: 'form-hint' }, URL_HINT[w?.kind ?? 'slack']);
  kindSel.addEventListener('change', () => { hint.textContent = URL_HINT[kindSel.value]; });
  const chosen = new Set(w ? w.events : events.filter((e) => e.chat_default).map((e) => e.id));
  openDialog(w ? `Editar ${w.name}` : 'Novo aviso', h('div', { class: 'row' },
    field('Tipo', kindSel, 'col-md-6'),
    field('Nome', h('input', { name: 'name', required: true, value: w?.name ?? '', placeholder: 'Ex.: Canal #suporte' }), 'col-md-6'),
    h('div', { class: 'col-12 mb-3' }, h('label', { class: 'form-label' }, w ? 'URL (deixe vazio para manter)' : 'URL'),
      h('input', { name: 'url', type: 'url', required: !w, autocomplete: 'off' }), hint),
    field('Só de um cliente', select('client_id', [['', 'Todos os clientes'], ...clients.map((c) => [c.id, c.name])], w?.client_id ?? ''), 'col-12'),
    h('div', { class: 'col-12' }, h('label', { class: 'form-label' }, 'Eventos'),
      h('div', { class: 'row' }, events.map((e) => h('div', { class: 'col-md-6' },
        check(h('input', { type: 'checkbox', name: 'events', value: e.id, checked: chosen.has(e.id) }), e.label, 'mb-1')))))),
  async (fd) => {
    const body = { name: fd.get('name'), events: fd.getAll('events'), client_id: Number(fd.get('client_id')) || undefined };
    if (fd.get('url')) body.url = fd.get('url');
    if (w) { await api('PUT', `/api/webhooks/${w.id}`, body); toast('Aviso guardado.'); render(); return; }
    const r = await api('POST', '/api/webhooks', { ...body, kind: fd.get('kind') });
    if (r.secret) {
      openDialog('Segredo de assinatura', h('div', {},
        h('p', {}, 'Guarde este segredo no sistema que recebe o webhook, para verificar a assinatura. Não volta a ser mostrado.'),
        h('input', { readonly: true, value: r.secret, onfocus: (e) => e.currentTarget.select() })), async () => { render(); }, { submitLabel: 'Fechar' });
    } else { toast('Aviso criado.'); render(); }
  }, { wide: true });
}

function webhooksCard(hooks, events, clients) {
  const label = Object.fromEntries(events.map((e) => [e.id, e.label]));
  const cname = Object.fromEntries(clients.map((c) => [c.id, c.name]));
  return card('Avisos e webhooks', [
    h('p', { class: 'text-secondary' }, 'Envie alterações para um canal do Slack ou do Teams, ou para outro sistema (ERP, PSA, automações). No Slack e no Teams, várias alterações seguidas chegam numa só mensagem.'),
    hooks.length ? table(['Destino', 'Eventos', 'Estado', ''], hooks.map((w) => h('tr', {},
      h('td', {}, h('div', {}, w.name, ' ', badge(KIND[w.kind])), h('div', { class: 'text-secondary small' }, w.url, w.client_id ? ` · só ${cname[w.client_id] || 'cliente'}` : '')),
      h('td', { class: 'text-secondary small' }, w.events.map((e) => label[e] || e).join(', ')),
      h('td', {}, !w.enabled ? badge('Desligado', 'warn') : w.last_status === 'erro' ? badge('Erro', 'danger') : w.last_status === 'ok' ? badge('OK', 'ok') : badge('Sem envios'),
        w.pending ? h('div', { class: 'text-secondary small' }, `${w.pending} em fila`) : null,
        w.last_error ? h('div', { class: 'text-danger small' }, w.last_error) : null),
      h('td', { class: 'text-end text-nowrap' },
        h('button', { class: 'link', onclick: async () => {
          const r = await api('POST', `/api/webhooks/${w.id}/test`);
          toast(r.ok ? 'Mensagem de teste enviada.' : `Falhou: ${r.error}`, !r.ok);
          render();
        } }, 'Testar'), ' · ',
        h('button', { class: 'link', onclick: () => webhookDialog(w, events, clients) }, 'Editar'), ' · ',
        h('button', { class: 'link', onclick: async () => { await api('PUT', `/api/webhooks/${w.id}`, { enabled: !w.enabled }); render(); } }, w.enabled ? 'Desligar' : 'Ligar'), ' · ',
        h('button', { class: 'link text-danger', onclick: async () => {
          if (await confirmDialog('Remover aviso', `Remover "${w.name}"?`)) { await api('DELETE', `/api/webhooks/${w.id}`); render(); }
        } }, 'Remover'))))) : null,
    h('div', { class: hooks.length ? 'mt-3' : '' }, h('button', { class: 'primary', onclick: () => webhookDialog(null, events, clients) }, icon('plus'), 'Novo aviso')),
  ]);
}
