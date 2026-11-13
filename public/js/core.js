/* Rizoma — núcleo da interface: estado, rótulos, utilitários DOM, componentes Tabler, API e diálogos.
   Todo o conteúdo dinâmico é inserido via DOM (textContent), nunca via innerHTML, para evitar XSS.
   A estrutura gráfica é o Tabler (https://tabler.io, MIT): as funções abaixo geram a sua marcação. */
import { renderLogin } from './auth.js';
import { TABLER_ICONS } from './icons.js';

// ======================================================================= estado
export let ME = null;
export let META = null;
export let AUTH = { oidc: null, require_2fa: false, signup: false, org_sso: false, terms_url: null, privacy_url: null };
export let shell = null;
export let main = null;

export const BRAND = 'Rizoma';

export const L = {
  status: { planeado: 'Planeado', em_stock: 'Em stock', em_producao: 'Em produção', em_manutencao: 'Em manutenção', abatido: 'Abatido' },
  crit: { baixa: 'Baixa', media: 'Média', alta: 'Alta', critica: 'Crítica' },
  env: { producao: 'Produção', qualidade: 'Qualidade', desenvolvimento: 'Desenvolvimento' },
  rel: { depende_de: 'depende de', corre_em: 'corre em', alojado_em: 'está alojado em', ligado_a: 'está ligado a', usa: 'usa' },
  relInv: { depende_de: 'é dependência de', corre_em: 'executa', alojado_em: 'aloja', ligado_a: 'está ligado a', usa: 'é usado por' },
  role: { admin: 'Administrador', tech: 'Técnico', client: 'Cliente (só leitura)' },
  source: { manual: 'Manual', agent: 'Agente', import: 'Importação', intune: 'Intune', azure: 'Azure', m365: 'Microsoft 365' },
  action: {
    create: 'criou', update: 'alterou', delete: 'eliminou', login: 'iniciou sessão', password: 'alterou a password',
    '2fa_on': 'ativou o 2FA', '2fa_off': 'desativou o 2FA', '2fa_reset': 'repôs o 2FA', sync: 'sincronizou', login_negado: 'login recusado',
    backup: 'criou cópia de segurança', digest: 'enviou o resumo semanal',
  },
  entity: {
    ci: 'Ativo', client: 'Cliente', site: 'Local', user: 'Utilizador', token: 'Token', relationship: 'Relação', connector: 'Conector cloud',
    contract: 'Contrato', ticket: 'Ticket', system: 'Sistema', ci_type: 'Tipo de ativo', organization: 'Organização', webhook: 'Aviso / webhook',
  },
  kind: { licenca: 'Licença', suporte: 'Suporte', manutencao: 'Manutenção', subscricao: 'Subscrição', garantia: 'Garantia', outsourcing: 'Outsourcing', outro: 'Outro' },
  cstatus: { ativo: 'Ativo', terminado: 'Terminado', cancelado: 'Cancelado' },
  billing: { mensal: 'Mensal', trimestral: 'Trimestral', anual: 'Anual', unico: 'Pagamento único' },
  syncStatus: { ok: ['Sucesso', 'ok'], parcial: ['Parcial', 'warn'], erro: ['Erro', 'danger'] },
  field: {
    name: 'Nome', type_id: 'Tipo', site_id: 'Local', status: 'Estado', environment: 'Ambiente', criticality: 'Criticidade',
    hostname: 'Hostname', ip_address: 'Endereço IP', serial_number: 'Nº de série', asset_tag: 'Etiqueta de inventário',
    manufacturer: 'Fabricante', model: 'Modelo', os: 'Sistema operativo', owner: 'Responsável',
    purchase_date: 'Data de compra', warranty_end: 'Fim de garantia', notes: 'Notas', attributes: 'Atributos',
    external_id: 'ID externo',
  },
};

/* O estado partilhado só pode ser reatribuído dentro deste módulo: os outros usam estes setters. */
export function setME(v) { ME = v; }
export function setMETA(v) { META = v; }
export function setAUTH(v) { AUTH = v; }
export function setShell(v) { shell = v; }
export function setMain(v) { main = v; }

// ======================================================================= utilitários DOM
/* Classes antigas de botão → classes Tabler (as vistas continuam a usar 'primary', 'danger', 'link'). */
export const BTN_VARIANT = { primary: 'btn-primary', danger: 'btn-outline-danger', link: 'btn-link' };
export function tablerize(el) {
  const tag = el.tagName;
  const cls = el.classList;
  if (tag === 'BUTTON' || (tag === 'A' && cls.contains('btn'))) {
    if (cls.contains('btn-close') || cls.contains('nav-link') || cls.contains('navbar-toggler') || cls.contains('list-group-item')) return;
    cls.add('btn');
    for (const [old, nu] of Object.entries(BTN_VARIANT)) if (cls.contains(old)) { cls.remove(old); cls.add(nu); }
    if (cls.contains('btn-link')) cls.add('p-0', 'align-baseline');
    if (cls.contains('btn-link') && cls.contains('small')) cls.add('btn-sm');
    if (cls.contains('btn-link') && el.dataset.danger !== undefined) cls.add('text-danger');
  } else if (tag === 'SELECT') {
    cls.add('form-select');
  } else if (tag === 'TEXTAREA') {
    cls.add('form-control');
  } else if (tag === 'INPUT') {
    const t = el.type;
    if (t === 'checkbox' || t === 'radio') cls.add('form-check-input');
    else if (t !== 'hidden') cls.add('form-control');
  }
}
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k === 'value') value = v;
    else if (k === 'checked' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  if (value !== undefined) el.value = value;
  tablerize(el);
  return el;
}

/** Ícone Tabler Icons (ver js/icons.js). */
export function icon(name, cls) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  svg.setAttribute('class', `icon${cls ? ` ${cls}` : ''}`);
  for (const [tag, attrs] of TABLER_ICONS[name] || []) {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    svg.append(e);
  }
  return svg;
}

/** Logótipo Rizoma: rizoma (caule horizontal com rebentos e raízes) numa placa da cor primária. */
export function brandMark(size = 32) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', 'brand-mark');
  svg.setAttribute('aria-hidden', 'true');
  const add = (tag, attrs) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); svg.append(e); };
  add('rect', { width: 32, height: 32, rx: 7, class: 'brand-mark-plate' });
  add('path', { d: 'M6 18h20M10 18v-6M17 18l3.5-7M13 18l-2 6M22 18l2 5', class: 'brand-mark-line' });
  add('circle', { cx: 10, cy: 10.5, r: 2.2, class: 'brand-mark-node' });
  add('circle', { cx: 21.2, cy: 9.6, r: 2.2, class: 'brand-mark-node' });
  return svg;
}
export function brandLogo(size = 32) {
  return h('span', { class: 'brand-logo' }, brandMark(size), h('span', { class: 'brand-word' }, 'rizoma'));
}

export function toast(msg, isError) {
  const t = h('div', { class: `alert ${isError ? 'alert-danger' : 'alert-success'} alert-dismissible shadow-sm mb-2`, role: isError ? 'alert' : 'status' },
    h('div', { class: 'd-flex align-items-center gap-2' }, icon(isError ? 'alert' : 'chevron', 'alert-icon'), h('div', {}, msg)));
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), isError ? 6000 : 3000);
}

/* Tons das etiquetas (as vistas usam 'ok', 'info', 'primary', 'warn', 'danger' ou nada). */
export const TONE = { '': 'secondary', ok: 'green', info: 'azure', primary: 'primary', warn: 'orange', danger: 'red' };
export const badge = (text, cls) => h('span', { class: `badge bg-${TONE[cls || ''] || 'secondary'}-lt` }, text);
export const STATUS_TONE = { em_producao: 'green', em_stock: 'azure', planeado: 'secondary', em_manutencao: 'orange', abatido: 'secondary' };
export const statusBadge = (s) => h('span', { class: `status status-${STATUS_TONE[s] || 'secondary'}${s === 'abatido' ? ' text-decoration-line-through' : ''}` },
  h('span', { class: 'status-dot' }), L.status[s] || s);
export const CRIT_TONE = { baixa: '', media: 'info', alta: 'warn', critica: 'danger' };
export const critBadge = (c) => badge(L.crit[c] || c, CRIT_TONE[c]);
export const fmtDate = (s) => (s ? new Date(s.replace(' ', 'T') + (s.length > 10 ? 'Z' : '')).toLocaleDateString('pt-PT') : '—');
export const fmtDateTime = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString('pt-PT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
export const dash = (v) => (v === null || v === undefined || v === '' ? '—' : v);
export const fmtMoney = (n) => (n === null || n === undefined ? '—' : n.toLocaleString('pt-PT', { style: 'currency', currency: 'EUR' }));
export const fmtBytes = (n) => (n === null || n === undefined ? '—' : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
export const todayIso = () => new Date().toISOString().slice(0, 10);
export const daysUntil = (d) => Math.round((Date.parse(d.slice(0, 10)) - Date.parse(todayIso())) / 864e5);
export const sourceBadge = (s) => (['agent', 'intune', 'azure', 'm365'].includes(s)
  ? badge(L.source[s], 'primary') : h('span', { class: 'text-secondary' }, L.source[s] || s));
export const canWrite = () => ME && ME.role !== 'client';
export const isAdmin = () => ME && ME.role === 'admin';

/** Tabela Tabler. headers: texto ou { label, cls: 'num' }. */
export function table(headers, rows, emptyText) {
  const th = (x) => (typeof x === 'string' ? h('th', {}, x) : h('th', { class: x.cls === 'num' ? 'text-end' : x.cls }, x.label));
  return h('div', { class: 'table-responsive' },
    h('table', { class: 'table table-vcenter card-table table-hover' },
      h('thead', {}, h('tr', {}, headers.map(th))),
      h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: headers.length, class: 'text-secondary py-4' }, emptyText || 'Sem registos.')))));
}

/** Cartão Tabler: título, ações à direita e corpo. Uma tabela passada como corpo fica encostada às margens. */
export function card(title, body, { actions = null, cls = '', sub = null, bodyless = false } = {}) {
  const kids = [].concat(body).filter((x) => x !== null && x !== undefined && x !== false);
  const flush = bodyless || (kids.length === 1 && kids[0] instanceof Element && kids[0].classList.contains('table-responsive'));
  return h('div', { class: `card ${cls}`.trim() },
    title ? h('div', { class: 'card-header' },
      h('div', {}, h('h2', { class: 'card-title' }, title), sub ? h('div', { class: 'card-subtitle text-secondary small mt-1' }, sub) : null),
      actions ? h('div', { class: 'card-actions d-flex gap-2' }, actions) : null) : null,
    flush ? kids : h('div', { class: 'card-body' }, kids));
}

/** Rodapé de paginação Tabler (página começa em 0). */
export function pagerFooter(page, size, total, go) {
  if (total <= size) return null;
  const last = (page + 1) * size >= total;
  const item = (label, disabled, to) => h('li', { class: `page-item${disabled ? ' disabled' : ''}` },
    h('a', { class: 'page-link', href: '#', onclick: (e) => { e.preventDefault(); if (!disabled) go(to); } }, label));
  return h('div', { class: 'card-footer d-flex align-items-center' },
    h('p', { class: 'm-0 text-secondary' }, `${page * size + 1}–${Math.min((page + 1) * size, total)} de ${total}`),
    h('ul', { class: 'pagination m-0 ms-auto' }, item('Anterior', page === 0, page - 1), item('Seguinte', last, page + 1)));
}

/** Caixa de verificação Tabler. */
export function check(input, label, cls) {
  return h('label', { class: `form-check ${cls || ''}`.trim() }, input, h('span', { class: 'form-check-label' }, label));
}

/** Lista de pares rótulo/valor. */
export function details(pairs) {
  return h('dl', { class: 'row mb-0 details' }, pairs.filter(Boolean).map(([k, v]) => [
    h('dt', { class: 'col-5 col-md-4 text-secondary fw-normal' }, k),
    h('dd', { class: 'col-7 col-md-8' }, v === null || v === undefined || v === '' ? '—' : v)]));
}

// ======================================================================= API
export async function api(method, url, body) {
  /** @type {RequestInit & { headers: Record<string, string> }} */
  const opt = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(url, opt);
  const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text();
  if (r.status === 401 && !url.startsWith('/api/login')) {
    ME = null;
    renderLogin('A sua sessão expirou. Inicie sessão novamente.');
    throw new Error('Sessão expirada');
  }
  if (!r.ok) throw new Error((data && data.error) || `Erro ${r.status}`);
  return data;
}
export const GET = (u) => api('GET', u);

// ======================================================================= diálogos (modal Tabler sobre <dialog>)
export function openDialog(title, fields, onSubmit, opts = {}) {
  const err = h('div', { class: 'alert alert-danger error', hidden: true });
  const submit = h('button', { class: opts.danger ? 'btn-danger' : 'primary', type: 'submit' }, opts.submitLabel || 'Guardar');
  const dlg = h('dialog', { class: `modal-native${opts.wide ? ' modal-native-lg' : ''}` });
  const form = h('form', {
    class: 'modal-content',
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      err.hidden = true;
      try {
        const keep = await onSubmit(new FormData(form), form);
        if (keep !== true) dlg.close();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      } finally {
        submit.disabled = false;
      }
    },
  },
  h('div', { class: 'modal-header' }, h('h2', { class: 'modal-title' }, title),
    h('button', { type: 'button', class: 'btn-close', 'aria-label': 'Fechar', onclick: () => dlg.close() })),
  h('div', { class: 'modal-body' }, err, fields),
  h('div', { class: 'modal-footer' },
    h('button', { type: 'button', class: 'me-auto', onclick: () => dlg.close() }, opts.cancelLabel || 'Cancelar'),
    opts.noSubmit ? null : submit));
  dlg.append(form);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, form };
}
export function field(label, input, cls) {
  return h('div', { class: `mb-3 ${cls || ''}`.trim() }, h('label', { class: 'form-label' }, label), input);
}
export function select(name, options, value, extra = {}) {
  return h('select', { name, ...extra, value: value ?? '' },
    options.map(([v, t]) => h('option', { value: v }, t)));
}
export async function confirmDialog(title, text, label = 'Eliminar') {
  return new Promise((resolve) => {
    let ok = false;
    const { dlg } = openDialog(title, h('p', { class: 'mb-0' }, text), () => { ok = true; }, { submitLabel: label, danger: true });
    dlg.addEventListener('close', () => resolve(ok));
  });
}

// ======================================================================= cache de clientes
export let clientsCache = null;
export async function getClients(force) {
  if (!clientsCache || force) clientsCache = await GET('/api/clients');
  return clientsCache;
}
