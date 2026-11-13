/* Vulnerabilidades conhecidas (CVE) no software instalado: página geral e cartão do ativo. */
import { GET, ME, badge, card, fmtDate, fmtDateTime, getClients, h, select, table } from '../core.js';
import { pageHead, setPage } from '../main.js';

const SEV = { CRITICAL: ['Crítica', 'danger'], HIGH: ['Alta', 'danger'], MEDIUM: ['Média', 'warn'], LOW: ['Baixa', null] };
export const sevBadge = (s, score) => {
  const [label, tone] = SEV[s] || ['—', null];
  return badge(score ? `${label} ${Number(score).toFixed(1)}` : label, tone);
};
const kevBadge = (added) => (added ? badge('Explorada (KEV)', 'danger') : null);
const cveLink = (id) => h('a', { href: `https://nvd.nist.gov/vuln/detail/${id}`, target: '_blank', rel: 'noopener' }, id);

export async function viewVulns(query) {
  const clients = await getClients(true);
  const qs = new URLSearchParams();
  for (const k of ['client_id', 'severity', 'kev']) if (query.get(k)) qs.set(k, query.get(k));
  const d = await GET(`/api/vulnerabilities?${qs}`);
  const go = (k, v) => { const q = new URLSearchParams(qs); if (v) q.set(k, v); else q.delete(k); location.hash = `#/vulnerabilidades${q.size ? `?${q}` : ''}`; };
  const filters = h('div', { class: 'd-flex gap-2 flex-wrap mb-3' },
    select('client_id', [['', 'Todos os clientes'], ...clients.map((c) => [c.id, c.name])], query.get('client_id') || '', { onchange: (e) => go('client_id', e.target.value), class: 'w-auto' }),
    select('severity', [['', 'Todas as gravidades'], ...Object.entries(SEV).map(([k, [l]]) => [k, l])], query.get('severity') || '', { onchange: (e) => go('severity', e.target.value), class: 'w-auto' }),
    h('label', { class: 'form-check form-switch m-0 align-self-center' },
      h('input', { type: 'checkbox', class: 'form-check-input', checked: query.get('kev') === '1', onchange: (e) => go('kev', e.target.checked ? '1' : '') }),
      h('span', { class: 'form-check-label' }, 'Só as já exploradas (KEV)')));

  setPage(
    pageHead('Vulnerabilidades', `${d.totals.cves} CVE em ${d.totals.cis} ativo(s) · ${d.totals.inventoried} ativo(s) com inventário de software`),
    !d.totals.inventoried ? h('div', { class: 'alert alert-info' },
      'Ainda não há inventário de software. O agente Windows (agent/inventario.ps1) envia a lista de programas instalados; atualize-o nos equipamentos dos clientes.') : null,
    card(null, [filters,
      table(['CVE', 'Gravidade', 'Software', { label: 'Ativos', cls: 'num' }, 'Detetada', 'Descrição'], d.items.map((v) => h('tr', {},
        h('td', { class: 'text-nowrap' }, cveLink(v.cve_id), v.kev_added ? h('div', {}, kevBadge(v.kev_added)) : null),
        h('td', {}, sevBadge(v.severity, v.score)),
        h('td', { class: 'small' }, (v.software || '').split(',').join(', ')),
        h('td', { class: 'num' }, String(v.cis)),
        h('td', { class: 'text-secondary text-nowrap' }, fmtDate(v.first_seen)),
        h('td', { class: 'text-secondary small' }, v.summary))), 'Nenhuma vulnerabilidade conhecida no software inventariado.')]),
    h('p', { class: 'text-secondary small' },
      `Fonte: NVD (NIST) e catálogo KEV (CISA). ${d.source.products} produto(s) acompanhado(s)${d.source.last_update ? `, atualizado em ${fmtDateTime(d.source.last_update)}` : ''}. `,
      'Abrange as aplicações Windows mais comuns (navegadores, compressores, acesso remoto, leitores de PDF, ferramentas de desenvolvimento). Pacotes de distribuições Linux ainda não são analisados.',
      ME.is_platform && !d.source.nvd_key ? ' Sem CMDB_NVD_API_KEY, a atualização é mais lenta.' : ''));
}

/** Cartão da ficha do ativo. */
export async function ciSoftwareCard(ciId) {
  const d = await GET(`/api/cis/${ciId}/software`);
  if (!d.software.length) return null;
  const list = h('div', { hidden: true, class: 'mt-3' }, table(['Programa', 'Versão', 'Editor'],
    d.software.map((s) => h('tr', {}, h('td', {}, s.name), h('td', { class: 'text-secondary' }, s.version || '—'), h('td', { class: 'text-secondary' }, s.publisher || '—')))));
  return card(`Software e vulnerabilidades · ${d.vulns.length} CVE`, [
    d.vulns.length ? table(['CVE', 'Gravidade', 'Software'], d.vulns.map((v) => h('tr', {},
      h('td', { class: 'text-nowrap' }, cveLink(v.cve_id), ' ', kevBadge(v.kev_added)),
      h('td', {}, sevBadge(v.severity, v.score)),
      h('td', { class: 'small' }, `${v.software} ${v.version}`))))
      : h('p', { class: 'text-secondary mb-0' }, 'Nenhuma vulnerabilidade conhecida no software deste ativo.'),
    h('button', { class: 'link mt-2', onclick: (e) => { list.hidden = !list.hidden; e.currentTarget.textContent = list.hidden ? `Ver os ${d.software.length} programas instalados` : 'Esconder a lista'; } },
      `Ver os ${d.software.length} programas instalados`),
    list,
  ]);
}
