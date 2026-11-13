/* Integrações da organização: RMM (NinjaOne). */
import { GET, api, badge, card, details, field, fmtDateTime, getClients, h, icon, isAdmin, openDialog, select, table, toast } from '../core.js';
import { pageHead, render, setPage } from '../main.js';

const REGION_LABEL = { eu: 'Europa (eu.ninjarmm.com)', us: 'EUA (app.ninjarmm.com)', us2: 'EUA 2 (us2.ninjarmm.com)', ca: 'Canadá (ca.ninjarmm.com)', oc: 'Oceânia (oc.ninjarmm.com)' };
const STATUS = { ok: ['OK', 'ok'], parcial: ['Parcial', 'warn'], erro: ['Erro', 'danger'] };

export async function viewIntegrations() {
  if (!isAdmin()) throw new Error('Apenas administradores.');
  const [n, clients] = await Promise.all([GET('/api/rmm'), getClients(true)]);

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
    pageHead('Integrações', 'Ferramentas de gestão remota (RMM)'),
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
      ...mappingTable()]) : null);
}
