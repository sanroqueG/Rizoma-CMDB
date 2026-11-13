/* Sistema (administração): estado da instalação, cópias de segurança e email. */
import { BRAND, GET, api, badge, card, details, fmtBytes, fmtDateTime, h, icon, isAdmin, table, toast } from '../core.js';
import { pageHead, render, setPage } from '../main.js';

export const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

export async function viewSystem() {
  if (!isAdmin()) throw new Error('Apenas administradores.');
  const s = await GET('/api/system');
  if (!s.platform_admin) {
    // Administrador de organização: só os números da sua organização; a infraestrutura é gerida pela plataforma
    const kpi0 = (label, value) => h('div', { class: 'col-6 col-lg-3' }, h('div', { class: 'card card-sm' }, h('div', { class: 'card-body' },
      h('div', { class: 'subheader' }, label), h('div', { class: 'h1 mb-0 mt-1' }, value))));
    setPage(pageHead('Sistema', `${BRAND} ${s.version}`),
      h('div', { class: 'row row-cards' }, kpi0('Clientes', s.counts.clients), kpi0('Ativos', s.counts.cis), kpi0('Contratos', s.counts.contracts), kpi0('Utilizadores', s.counts.users)),
      card('Cópias de segurança', h('p', { class: 'text-secondary mb-0' }, 'As cópias de segurança e a infraestrutura são geridas pela plataforma. Para ter uma cópia dos seus dados, use "Exportar todos os dados" em Organização.')),
      card('Resumo semanal por email', s.email.enabled
        ? [h('p', { class: 'text-secondary' }, `Enviado ${WEEKDAYS[s.email.digest_weekday] || ''} a partir das ${s.email.digest_hour}h aos administradores e técnicos da organização.`),
          h('button', { onclick: async () => { const r = await api('POST', '/api/system/digest'); toast(`Resumo: ${r.sent} enviado(s), ${r.empty} sem assuntos.`); } }, 'Enviar resumo agora')]
        : h('p', { class: 'text-secondary mb-0' }, 'O envio de email não está ativo nesta plataforma.')));
    return;
  }
  const uptime = (sec) => (sec < 3600 ? `${Math.round(sec / 60)} min` : sec < 86400 ? `${(sec / 3600).toFixed(1)} h` : `${(sec / 86400).toFixed(1)} dias`);

  async function busy(btn, label, fn) {
    const old = [...btn.childNodes];
    btn.disabled = true;
    btn.textContent = label;
    try { await fn(); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; btn.replaceChildren(...old); }
  }

  const backupCard = card('Cópias de segurança', s.backups.enabled
    ? [h('div', { class: 'card-body' },
      h('p', { class: 'text-secondary mb-2' }, `Automáticas a cada ${s.backups.every_hours ?? '?'} h · mantém as ${s.backups.keep} mais recentes · pasta `, h('code', {}, s.backups.dir)),
      h('div', { class: 'alert alert-info mb-0' }, 'Cada cópia inclui a chave de encriptação (.key). Guarde as cópias fora deste servidor e proteja o acesso à pasta.')),
    table(['Ficheiro', 'Criada', { label: 'Tamanho', cls: 'num' }, 'Chave'], s.backups.items.map((b) => h('tr', {},
      h('td', { class: 'font-monospace small' }, b.file), h('td', { class: 'text-secondary' }, fmtDateTime(b.created_at.replace('T', ' ').slice(0, 19))),
      h('td', { class: 'text-end' }, fmtBytes(b.size)), h('td', {}, b.has_key ? badge('incluída', 'ok') : h('span', { class: 'text-secondary small' }, 'CMDB_SECRET_KEY')))),
    'Ainda não existem cópias.')]
    : h('div', { class: 'card-body text-secondary' }, 'Desativadas (CMDB_BACKUP_HOURS=0). Garanta cópias da pasta de dados por outro meio.'),
  { bodyless: true, actions: s.backups.enabled ? h('button', { class: 'btn-sm', onclick: (e) => busy(e.currentTarget, 'A copiar…', async () => {
    const r = await api('POST', '/api/system/backups');
    toast(`Cópia criada: ${r.file} (${fmtBytes(r.size)}).`);
    render();
  }) }, icon('backup'), 'Criar cópia agora') : null });

  const emailCard = card('Email e resumo semanal', s.email.enabled
    ? details([
      ['Servidor SMTP', s.email.host], ['Remetente', s.email.from],
      ['Resumo automático', s.email.digest_weekday === null ? 'desativado' : `${WEEKDAYS[s.email.digest_weekday] || '?'}, a partir das ${s.email.digest_hour}h`],
      ['Último resumo', s.email.last_digest ? fmtDateTime(s.email.last_digest.replace('T', ' ').slice(0, 19)) : 'nunca'],
      ['Destinatários', 'administradores e técnicos com email, que não tenham desligado o resumo']])
    : [h('p', { class: 'text-secondary' }, 'O envio de email não está configurado.'),
      h('p', { class: 'small mb-0' }, 'Defina CMDB_SMTP_HOST, CMDB_SMTP_PORT, CMDB_SMTP_USER, CMDB_SMTP_PASS e CMDB_SMTP_FROM e reinicie o servidor. Cada utilizador recebe, uma vez por semana, as garantias e contratos a expirar e os agentes sem contacto dos seus clientes.')],
  { actions: s.email.enabled ? [
    h('button', { class: 'btn-sm', onclick: (e) => busy(e.currentTarget, 'A enviar…', async () => {
      const r = await api('POST', '/api/system/email/test');
      toast(`Email de teste enviado para ${r.to}.`);
    }) }, icon('mail'), 'Email de teste'),
    h('button', { class: 'btn-sm', onclick: (e) => busy(e.currentTarget, 'A enviar…', async () => {
      const r = await api('POST', '/api/system/digest');
      toast(`Resumo: ${r.sent} enviado(s), ${r.empty} sem assuntos${r.failed.length ? `, ${r.failed.length} com erro` : ''}.`, r.failed.length > 0);
      render();
    }) }, 'Enviar resumo agora')] : null });

  const kpi = (label, value) => h('div', { class: 'col-6 col-lg-3' }, h('div', { class: 'card card-sm' }, h('div', { class: 'card-body' },
    h('div', { class: 'subheader' }, label), h('div', { class: 'h1 mb-0 mt-1' }, value))));
  setPage(
    pageHead('Sistema', `${BRAND} ${s.version} · Node.js ${s.node}`),
    h('div', { class: 'row row-cards' },
      kpi('Clientes', s.counts.clients), kpi('Ativos', s.counts.cis), kpi('Contratos', s.counts.contracts), kpi('Utilizadores', s.counts.users)),
    h('div', { class: 'row row-cards' },
      h('div', { class: 'col-lg-7 d-flex flex-column gap-3' }, backupCard),
      h('div', { class: 'col-lg-5 d-flex flex-column gap-3' }, emailCard,
        card('Instalação', details([
          ['Versão', s.version], ['Node.js', s.node], ['Sistema', s.platform],
          ['Em execução há', uptime(s.uptime_s)],
          ['Base de dados', s.db.file ? h('code', { class: 'text-break' }, s.db.file) : 'em memória'], ['Tamanho da BD', fmtBytes(s.db.size)],
          ['Versão do esquema', s.db.schema_version],
          ['Eventos de auditoria', s.counts.audit],
          ['Health check', h('a', { href: '/api/health', target: '_blank', rel: 'noopener' }, '/api/health')]])))));
}
