/* Layout, router, atalhos de teclado, palete de pesquisa e arranque. Carregado depois das vistas. */
import { renderLogin, viewAccount, renderPublicPage } from './auth.js';
import { AUTH, BRAND, GET, L, ME, api, brandLogo, canWrite, fmtDate, h, icon, isAdmin, main, openDialog, select, setAUTH, setME, setMETA, setMain, setShell, shell } from './core.js';
import { viewAudit, viewUsers, viewTypes } from './views/admin.js';
import { viewCi, viewCiForm, viewCis } from './views/cis.js';
import { viewClient, viewClientMap, viewClients } from './views/clients.js';
import { viewContract, viewContractForm, viewContracts } from './views/contracts.js';
import { viewDashboard } from './views/dashboard.js';
import { viewImport } from './views/import.js';
import { viewOrganization, viewPlatform } from './views/orgs.js';
import { billingBanner, viewBilling } from './views/billing.js';
import { viewIntegrations } from './views/integrations.js';
import { viewClientReport } from './views/reports.js';
import { viewSystem } from './views/system.js';

// ======================================================================= layout (Tabler: navbar vertical + page-wrapper)
export function buildShell() {
  const items = [
    ['Inventário'],
    ['#/', 'dashboard', 'Dashboard', 'G D'],
    ['#/ativos', 'assets', 'Ativos', 'G A'],
    ['#/clientes', 'clients', 'Clientes', 'G C'],
    ['#/contratos', 'contracts', 'Contratos', 'G K'],
    canWrite() && ['#/importar', 'import', 'Importar', 'G I'],
    isAdmin() && ['Administração'],
    isAdmin() && ['#/utilizadores', 'users', 'Utilizadores', 'G U'],
    isAdmin() && ['#/auditoria', 'audit', 'Auditoria', 'G L'],
    isAdmin() && ['#/tipos', 'assets', 'Tipos de ativo', 'G T'],
    isAdmin() && ['#/integracoes', 'cloud', 'Integrações', 'G N'],
    isAdmin() && ['#/organizacao', 'clients', 'Organização', 'G O'],
    isAdmin() && ME.billing && ['#/subscricao', 'key', 'Subscrição', 'G B'],
    isAdmin() && ['#/sistema', 'system', 'Sistema', 'G S'],
    ME.is_platform && ['#/plataforma', 'lock', 'Plataforma', 'G F'],
  ].filter(Boolean);
  const initials = ME.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  const collapse = h('div', { class: 'collapse navbar-collapse', id: 'sidebar-menu' },
    h('div', { class: 'px-3 pt-3 pt-lg-0 w-100' },
      h('button', { type: 'button', class: 'btn-ghost-light w-100 justify-content-start nav-search', onclick: openPalette, title: 'Procurar ativos, clientes e contratos' },
        icon('search'), h('span', { class: 'ms-1' }, 'Procurar…'), h('kbd', { class: 'ms-auto' }, 'Ctrl K'))),
    h('ul', { class: 'navbar-nav pt-lg-3' }, items.map((it) => (it.length === 1
      ? h('li', { class: 'nav-item nav-group' }, it[0])
      : h('li', { class: 'nav-item', 'data-nav': it[0] },
        h('a', { class: 'nav-link', href: it[0] },
          h('span', { class: 'nav-link-icon d-md-none d-lg-inline-block' }, icon(it[1])),
          h('span', { class: 'nav-link-title' }, it[2]), h('kbd', { class: 'nav-kbd ms-auto' }, it[3])))))),
    h('div', { class: 'nav-user mt-auto' },
      h('div', { class: 'd-flex align-items-center gap-2 px-3 py-3' },
        h('span', { class: 'avatar avatar-sm bg-primary text-white' }, initials),
        h('div', { class: 'lh-sm overflow-hidden' }, h('div', { class: 'text-truncate fw-medium' }, ME.name), h('div', { class: 'small text-secondary' }, L.role[ME.role]))),
      h('div', { class: 'd-flex gap-1 px-3 pb-3' },
        h('a', { class: 'btn btn-ghost-light btn-sm', href: '#/conta' }, icon('account'), 'Conta'),
        h('button', { type: 'button', class: 'btn-ghost-light btn-sm', onclick: shortcutsDialog, title: 'Atalhos de teclado' }, icon('keyboard')),
        h('button', { type: 'button', class: 'btn-ghost-light btn-sm ms-auto', onclick: async () => { await api('POST', '/api/logout'); setME(null); location.hash = '#/'; renderLogin(); } }, icon('logout'), 'Sair'))));
  const aside = h('aside', { class: 'navbar navbar-vertical navbar-expand-lg', 'data-bs-theme': 'dark' },
    h('div', { class: 'container-fluid' },
      h('button', { class: 'navbar-toggler', type: 'button', 'aria-label': 'Menu', 'aria-controls': 'sidebar-menu', onclick: () => collapse.classList.toggle('show') },
        h('span', { class: 'navbar-toggler-icon' })),
      h('div', { class: 'navbar-brand navbar-brand-autodark' }, h('a', { href: '#/', 'aria-label': `${BRAND} — início` }, brandLogo(28))),
      collapse));
  setMain(h('main', { class: 'main page-wrapper' }));
  setShell(h('div', { class: 'page' }, aside, main));
  shell.collapse = collapse;
  document.getElementById('app').replaceChildren(shell);
}
export function setActiveNav(path) {
  for (const li of shell.querySelectorAll('[data-nav]')) {
    const href = li.getAttribute('data-nav').slice(1);
    const on = href === '/' ? path === '/' : path.startsWith(href);
    li.classList.toggle('active', on);
    li.querySelector('.nav-link').classList.toggle('active', on);
  }
  shell.collapse.classList.remove('show');
}
/** Cabeçalho de página Tabler. title: texto, ou { title, crumbs: [[rótulo, href?], …] } */
export function pageHead(title, sub, ...actions) {
  const t = title && typeof title === 'object' && !(title instanceof Node) ? title : { title };
  const acts = actions.flat().filter(Boolean);
  return h('div', { class: 'page-header d-print-none' },
    h('div', { class: 'container-xl' },
      h('div', { class: 'row g-2 align-items-center' },
        h('div', { class: 'col' },
          t.crumbs ? h('ol', { class: 'breadcrumb breadcrumb-arrows mb-1' }, t.crumbs.map(([label, href]) =>
            h('li', { class: 'breadcrumb-item' }, href ? h('a', { href }, label) : label))) : null,
          h('h1', { class: 'page-title' }, t.title),
          sub ? h('div', { class: 'text-secondary mt-1 page-sub' }, sub) : null),
        acts.length ? h('div', { class: 'col-auto ms-auto' }, h('div', { class: 'btn-list' }, acts)) : null)));
}
/** Coloca o cabeçalho (se o primeiro filho for um) e o resto no corpo da página. */
export function setPage(...children) {
  const kids = children.flat().filter(Boolean);
  const head = kids[0] && kids[0].classList && kids[0].classList.contains('page-header') ? kids.shift() : null;
  main.replaceChildren(...[head, h('div', { class: 'page-body' }, h('div', { class: 'container-xl' }, h('div', { class: 'page-stack' }, billingBanner(), kids)))].filter(Boolean));
}

// ======================================================================= router
/** @type {Array<[RegExp, (...args: any[]) => any]>} */
export const ROUTES = [
  [/^\/$/, viewDashboard],
  [/^\/clientes$/, viewClients],
  [/^\/clientes\/(\d+)$/, viewClient],
  [/^\/clientes\/(\d+)\/mapa$/, viewClientMap],
  [/^\/clientes\/(\d+)\/relatorio$/, viewClientReport],
  [/^\/contratos$/, viewContracts],
  [/^\/contratos\/novo$/, (q) => viewContractForm(null, q)],
  [/^\/contratos\/(\d+)$/, viewContract],
  [/^\/contratos\/(\d+)\/editar$/, (id) => viewContractForm(id)],
  [/^\/sistema$/, viewSystem],
  [/^\/organizacao$/, viewOrganization],
  [/^\/tipos$/, viewTypes],
  [/^\/integracoes$/, viewIntegrations],
  [/^\/subscricao$/, viewBilling],
  [/^\/plataforma$/, viewPlatform],
  [/^\/importar$/, viewImport],
  [/^\/ativos$/, viewCis],
  [/^\/ativos\/novo$/, (q) => viewCiForm(null, q)],
  [/^\/ativos\/(\d+)$/, viewCi],
  [/^\/ativos\/(\d+)\/editar$/, (id) => viewCiForm(id)],
  [/^\/utilizadores$/, viewUsers],
  [/^\/auditoria$/, viewAudit],
  [/^\/conta$/, viewAccount],
];
export function parseHash() {
  const raw = location.hash.slice(1) || '/';
  const [p, q] = raw.split('?');
  return { path: p || '/', query: new URLSearchParams(q || '') };
}
export let renderSeq = 0;
export async function render() {
  if (!ME) return renderLogin();
  if (!shell) buildShell();
  const { path, query } = parseHash();
  if ((ME.password_change_required || ME.mfa_setup_required) && path !== '/conta') {
    location.hash = '#/conta';
    return;
  }
  setActiveNav(path);
  const seq = ++renderSeq;
  for (const [re, fn] of ROUTES) {
    const m = re.exec(path);
    if (!m) continue;
    setPage(h('div', { class: 'text-secondary d-flex align-items-center gap-2 py-4' }, h('span', { class: 'spinner-border spinner-border-sm' }), 'A carregar…'));
    try {
      await fn(...m.slice(1), query);
    } catch (e) {
      if (seq === renderSeq && ME) setPage(pageHead('Erro'), h('div', { class: 'alert alert-danger error' }, e.message));
    }
    window.scrollTo(0, 0);
    return;
  }
  setPage(pageHead('Página não encontrada'), h('a', { href: '#/' }, 'Voltar ao início'));
}
window.addEventListener('hashchange', render);

// ======================================================================= ergonomia: linhas clicáveis, atalhos, palete
document.addEventListener('click', (e) => {
  const target = /** @type {Element} */ (e.target);
  const tr = /** @type {HTMLElement | null} */ (target.closest && target.closest('tr[data-href]'));
  if (!tr || target.closest('a, button, input, select, label')) return;
  if (e.ctrlKey || e.metaKey) { window.open(location.pathname + tr.dataset.href, '_blank'); return; }
  location.hash = tr.dataset.href;
});

export function moveRowSel(dir) {
  const rows = [...main.querySelectorAll('tr[data-href]')];
  if (!rows.length) return false;
  const cur = rows.findIndex((r) => r.classList.contains('kb-sel'));
  const next = cur < 0 ? (dir > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, cur + dir));
  rows.forEach((r) => r.classList.remove('kb-sel'));
  rows[next].classList.add('kb-sel');
  rows[next].scrollIntoView({ block: 'nearest' });
  return true;
}

export const GO = { d: '#/', a: '#/ativos', c: '#/clientes', k: '#/contratos', i: '#/importar', u: '#/utilizadores', l: '#/auditoria', s: '#/sistema', o: '#/organizacao', t: '#/tipos', n: '#/integracoes', b: '#/subscricao', f: '#/plataforma', p: '#/conta' };
export let gPressedAt = 0;
document.addEventListener('keydown', (e) => {
  if (!ME || !shell) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
  const target = /** @type {Element} */ (e.target);
  if (target.closest && target.closest('input, textarea, select, [contenteditable], dialog')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  if (Date.now() - gPressedAt < 1200 && GO[k.toLowerCase()]) { e.preventDefault(); gPressedAt = 0; location.hash = GO[k.toLowerCase()]; return; }
  gPressedAt = 0;
  if (k === 'g' || k === 'G') { gPressedAt = Date.now(); return; }
  if (k === '/') {
    e.preventDefault();
    const s = main.querySelector('input[type="search"]');
    if (s) { s.focus(); s.select(); } else openPalette();
    return;
  }
  if (k === 'n' && canWrite()) { e.preventDefault(); location.hash = '#/ativos/novo'; return; }
  if (k === '?') { e.preventDefault(); shortcutsDialog(); return; }
  if (k === 'j' || k === 'ArrowDown' || k === 'k' || k === 'ArrowUp') {
    if (moveRowSel(k === 'j' || k === 'ArrowDown' ? 1 : -1)) e.preventDefault();
    return;
  }
  if (k === 'Enter') {
    const r = main.querySelector('tr.kb-sel[data-href]');
    if (r) { e.preventDefault(); location.hash = r.dataset.href; }
  }
});

export function shortcutsDialog() {
  const rows = [
    ['Ctrl K', 'Procurar ativos e clientes / ir para…'], ['/', 'Focar a pesquisa da lista'],
    ['G D', 'Dashboard'], ['G A', 'Ativos'], ['G C', 'Clientes'], ['G K', 'Contratos'], ['G I', 'Importar'],
    ['G U', 'Utilizadores'], ['G L', 'Auditoria'], ['G S', 'Sistema'], ['G P', 'A minha conta'],
    ['J / K', 'Linha seguinte / anterior'], ['Enter', 'Abrir a linha selecionada'],
    ['N', 'Novo ativo'], ['Ctrl + clique', 'Abrir linha num novo separador'], ['?', 'Esta ajuda'],
  ];
  openDialog('Atalhos de teclado', h('div', { class: 'keys' },
    rows.map(([k, d]) => [h('span', {}, k.split(' ').map((x) => (x === '/' && k !== '/' ? ' / ' : h('kbd', {}, x)))), h('span', {}, d)])),
  () => {}, { noSubmit: true, cancelLabel: 'Fechar' });
}

export function openPalette() {
  if (!ME || document.querySelector('dialog.palette')) return;
  const input = h('input', { type: 'text', placeholder: 'Procurar ativo, cliente, contrato, ticket, nº de série, IP… ou ir para', 'aria-label': 'Procurar', autocomplete: 'off', spellcheck: 'false' });
  input.classList.add('form-control-lg', 'border-0', 'rounded-0');
  const list = h('ul', { role: 'listbox', class: 'list-group list-group-flush' });
  const dlg = h('dialog', { class: 'palette' }, input, list,
    h('div', { class: 'hint text-secondary small' },
      h('span', {}, h('kbd', {}, '↑'), h('kbd', {}, '↓'), 'navegar'),
      h('span', {}, h('kbd', {}, 'Enter'), 'abrir'),
      h('span', {}, h('kbd', {}, 'Esc'), 'fechar')));
  const commands = [
    ['Ir para', 'Dashboard', '#/'], ['Ir para', 'Ativos', '#/ativos'], ['Ir para', 'Clientes', '#/clientes'],
    ['Ir para', 'Contratos', '#/contratos'], ['Ir para', 'Renovações (90 dias)', '#/contratos?expiring=90'],
    canWrite() && ['Ação', 'Novo ativo', '#/ativos/novo'], canWrite() && ['Ação', 'Novo contrato', '#/contratos/novo'],
    canWrite() && ['Ir para', 'Importar', '#/importar'],
    isAdmin() && ['Ir para', 'Utilizadores', '#/utilizadores'], isAdmin() && ['Ir para', 'Auditoria', '#/auditoria'],
    isAdmin() && ['Ir para', 'Sistema', '#/sistema'],
    ['Ir para', 'A minha conta', '#/conta'],
  ].filter(Boolean).map(([kind, label, href]) => ({ kind, label, href, meta: '' }));
  let items = commands;
  let sel = 0;
  let seq = 0;
  let timer = null;

  function draw() {
    list.replaceChildren(...items.map((it, i) => h('li', {
      class: `list-group-item list-group-item-action d-flex align-items-center gap-3${i === sel ? ' active' : ''}`, role: 'option',
      onclick: () => go(it), onmousemove: () => { if (sel !== i) { sel = i; draw(); } },
    }, h('span', { class: 'badge bg-secondary-lt kind' }, it.kind), h('span', { class: 'flex-fill text-truncate' }, it.label),
    h('span', { class: 'text-secondary small text-truncate meta' }, it.meta))));
    if (!items.length) list.append(h('li', { class: 'list-group-item text-secondary' }, 'Sem resultados'));
  }
  function go(it) { dlg.close(); location.hash = it.href; }
  async function search() {
    const q = input.value.trim();
    const nq = q.toLowerCase();
    const my = ++seq;
    const cmds = commands.filter((c) => !nq || c.label.toLowerCase().includes(nq));
    let found = [];
    if (q.length >= 2) {
      const r = await GET(`/api/search?q=${encodeURIComponent(q.slice(0, 100))}`);
      if (my !== seq) return;
      found = [
        ...r.clients.map((c) => ({ kind: 'Cliente', label: c.name, href: `#/clientes/${c.id}`, meta: c.code })),
        ...r.cis.map((ci) => ({ kind: 'Ativo', label: ci.name, href: `#/ativos/${ci.id}`,
          meta: [ci.client_code, ci.hostname !== ci.name && ci.hostname, ci.serial_number || ci.ip_address || ci.type_name].filter(Boolean).join(' · ') })),
        ...r.contracts.map((k) => ({ kind: 'Contrato', label: k.name, href: `#/contratos/${k.id}`,
          meta: [k.client_code, k.vendor, k.end_date && `fim ${fmtDate(k.end_date)}`].filter(Boolean).join(' · ') })),
        ...r.tickets.filter((t) => t.ci_id).map((t) => ({ kind: 'Ticket', label: `${t.system} ${t.external_id}${t.title ? ` — ${t.title}` : ''}`,
          href: `#/ativos/${t.ci_id}`, meta: [t.client_code, t.closed ? 'fechado' : 'aberto'].join(' · ') })),
        ...r.sites.map((s) => ({ kind: 'Local', label: s.name, href: `#/ativos?client=${s.client_id}&site=${s.id}`, meta: [s.client_code, s.address].filter(Boolean).join(' · ') })),
      ];
    }
    items = [...found, ...cmds];
    sel = 0;
    draw();
  }
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => search().catch(() => {}), 120); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = e.key === 'ArrowDown' ? Math.min(items.length - 1, sel + 1) : Math.max(0, sel - 1);
      draw();
      if (list.children[sel]) list.children[sel].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items[sel]) go(items[sel]);
    }
  });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  input.focus();
  draw();
}

// ======================================================================= arranque
(async function boot() {
  setAUTH(await fetch('/api/auth/config').then((x) => x.json()).catch(() => AUTH));
  const { path, query } = parseHash();
  // Ligações recebidas por email (redefinir password, convite, verificar email) funcionam sem sessão
  if (await renderPublicPage(path, query)) return;
  const ssoError = query.get('sso_erro');
  if (ssoError) history.replaceState(null, '', '#/');
  const r = await fetch('/api/me', { credentials: 'same-origin' }).catch(() => null);
  if (!r || !r.ok) return renderLogin(ssoError || undefined);
  setME(await r.json());
  setMETA(await GET('/api/meta'));
  render();
}());
