/* Importação de CSV / Excel. */
import { L, META, api, badge, canWrite, card, check, confirmDialog, dash, field, getClients, h, icon, select, table, toast } from '../core.js';
import { pageHead, setPage } from '../main.js';

// ======================================================================= importação
export async function viewImport(query) {
  if (!canWrite()) throw new Error('Sem permissão de escrita.');
  const clients = await getClients(true);
  let parsed = null;
  const clientSel = select('client', [['', '— escolher —'], ...clients.map((c) => [c.id, c.name])],
    query.get('client') || (clients.length === 1 ? clients[0].id : ''), { required: true });
  const fileIn = h('input', { type: 'file', accept: '.csv,.xlsx,.txt' });
  const optUpdate = h('input', { type: 'checkbox', checked: true });
  const optSites = h('input', { type: 'checkbox', checked: true });
  const preview = h('div', { hidden: true });
  const result = h('div', { hidden: true });
  const btnSim = h('button', { type: 'button', disabled: true, onclick: () => runImport(true) }, 'Simular');
  const btnRun = h('button', { type: 'button', class: 'primary', disabled: true, onclick: () => runImport(false) }, icon('import'), 'Importar');
  const kpiMini = (l, v, tone) => h('div', { class: 'col-6 col-md-3' }, h('div', { class: 'card card-sm' }, h('div', { class: 'card-body' },
    h('div', { class: 'subheader' }, l), h('div', { class: `h2 mb-0 mt-1${tone ? ` text-${tone}` : ''}` }, v))));

  fileIn.addEventListener('change', async () => {
    result.hidden = true;
    parsed = null;
    btnSim.disabled = true;
    btnRun.disabled = true;
    const f = fileIn.files[0];
    if (!f) { preview.hidden = true; return; }
    preview.hidden = false;
    preview.replaceChildren(card(null, h('p', { class: 'text-secondary mb-0' }, 'A ler o ficheiro…')));
    try {
      parsed = await FileTables.readTable(f);
      preview.replaceChildren(card(`Pré-visualização — ${f.name}`,
        table(parsed.headers, parsed.rows.slice(0, 5).map((r) => h('tr', {}, parsed.headers.map((hd) => h('td', {}, r[hd]))))),
        { sub: `${parsed.rows.length} linha(s) de dados · ${parsed.headers.length} coluna(s). Primeiras 5 linhas.` }));
      btnSim.disabled = false;
      btnRun.disabled = false;
    } catch (e) {
      preview.replaceChildren(h('div', { class: 'alert alert-danger' }, e.message));
    }
  });

  async function runImport(dry) {
    if (!clientSel.value) { toast('Escolha o cliente.', true); return; }
    if (!dry && !(await confirmDialog('Importar ativos',
      `Importar ${parsed.rows.length} linha(s) para "${clientSel.selectedOptions[0].textContent}"?`, 'Importar'))) return;
    btnSim.disabled = true;
    btnRun.disabled = true;
    try {
      const r = await api('POST', '/api/import', {
        client_id: Number(clientSel.value), rows: parsed.rows, dry_run: dry, update: optUpdate.checked, create_sites: optSites.checked,
      });
      showResult(r);
      if (!dry) toast(`Importação concluída: ${r.summary.created} criados, ${r.summary.updated} atualizados.`);
    } catch (e) {
      result.hidden = false;
      result.replaceChildren(h('div', { class: 'alert alert-danger' }, e.message));
    } finally {
      btnSim.disabled = false;
      btnRun.disabled = false;
    }
  }

  function showResult(r) {
    const s = r.summary;
    const fieldName = (f) => (f === 'type' ? 'Tipo' : f === 'site' ? 'Local' : L.field[f] || f);
    const chips = Object.entries(r.columns).map(([col, f]) => badge(
      `${col} → ${f === null ? 'ignorada' : f === 'attributes' ? 'atributo' : fieldName(f)}`, f === null ? '' : f === 'attributes' ? 'info' : 'ok'));
    const act = { created: ['Criar', 'ok'], updated: ['Atualizar', 'info'], unchanged: ['Sem alterações', ''], error: ['Erro', 'danger'] };
    const shown = r.results.filter((x) => x.action !== 'unchanged').slice(0, 500);
    result.hidden = false;
    result.replaceChildren(h('div', { class: 'd-flex flex-column gap-3' },
      h('h2', { class: 'mb-0' }, r.dry_run ? 'Resultado da simulação (nada foi gravado)' : 'Resultado da importação'),
      h('div', { class: 'row row-cards' }, kpiMini(r.dry_run ? 'A criar' : 'Criados', s.created, 'green'), kpiMini(r.dry_run ? 'A atualizar' : 'Atualizados', s.updated, 'azure'),
        kpiMini('Sem alterações', s.unchanged), kpiMini('Com erros', s.errors, s.errors ? 'red' : null)),
      card('Linhas', table(['Linha', 'Ativo', 'Ação', 'Detalhe'], shown.map((x) => h('tr', {},
        h('td', { class: 'text-secondary' }, x.row),
        h('td', {}, x.id && !r.dry_run ? h('a', { href: `#/ativos/${x.id}` }, x.name) : dash(x.name)),
        h('td', {}, badge(...act[x.action])), h('td', { class: 'text-secondary small' }, x.error || ''))), 'Nada a criar ou atualizar.'),
      { sub: [s.sites_created ? `${s.sites_created} local(is) novo(s) ${r.dry_run ? 'serão' : 'foram'} criado(s).` : null,
        r.results.length > shown.length ? 'As linhas sem alterações não são listadas.' : null].filter(Boolean).join(' ') || null,
      actions: !r.dry_run ? h('a', { class: 'btn btn-sm', href: `#/ativos?client=${clientSel.value}` }, 'Ver os ativos do cliente') : null }),
      card('Correspondência das colunas', h('div', { class: 'd-flex flex-wrap gap-1' }, chips))));
  }

  const template = h('button', {
    type: 'button', class: 'link',
    onclick: () => {
      const head = ['Nome', 'Tipo', 'Estado', 'Criticidade', 'Ambiente', 'Local', 'Hostname', 'Endereço IP', 'Nº de série', 'Etiqueta',
        'Fabricante', 'Modelo', 'Sistema operativo', 'Responsável', 'Data de compra', 'Fim de garantia', 'Notas'];
      const ex = ['PC-001', 'Portátil', 'Em produção', 'Média', 'Produção', 'Sede', 'PC-001', '10.0.0.15', '5CG1234XYZ', 'INV-0001',
        'HP', 'EliteBook 840 G10', 'Windows 11 Pro', 'Ana Silva', '15/03/2024', '15/03/2027', ''];
      const csv = `﻿${[head, ex].map((r) => r.join(';')).join('\r\n')}`;
      const a = h('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: 'modelo-importacao-rizoma.csv' });
      document.body.append(a);
      a.click();
      a.remove();
    },
  }, 'Descarregar modelo (CSV)');

  setPage(
    pageHead('Importar ativos', 'A partir de CSV ou Excel (.xlsx). A primeira linha deve ter os nomes das colunas.'),
    h('div', { class: 'card' },
      h('div', { class: 'card-body' },
        h('div', { class: 'row' }, field('Cliente', clientSel, 'col-md-6'), field('Ficheiro', fileIn, 'col-md-6')),
        h('div', { class: 'mb-3' },
          check(optUpdate, 'Atualizar ativos existentes (procura por nº de série, hostname ou nome)'),
          check(optSites, 'Criar os locais que ainda não existam')),
        h('details', {}, h('summary', { class: 'text-secondary' }, 'Que colunas são reconhecidas?'),
          h('div', { class: 'small mt-2' },
            h('p', {}, 'Nome (obrigatório), Tipo, Estado, Criticidade, Ambiente, Local, Hostname, Endereço IP, Nº de série, Etiqueta, Fabricante, Modelo, Sistema operativo, Responsável, Data de compra, Fim de garantia e Notas. Também aceita os nomes em inglês e o CSV exportado pelo próprio Rizoma. As restantes colunas ficam guardadas como atributos.'),
            h('p', {}, `Tipos: ${META.types.map((t) => t.name).join(', ')}. Sem tipo, assume "Posto de trabalho".`),
            h('p', { class: 'mb-0' }, 'Datas: AAAA-MM-DD ou DD/MM/AAAA (as datas do Excel são convertidas automaticamente).')))),
      h('div', { class: 'card-footer d-flex align-items-center' }, template, h('div', { class: 'btn-list ms-auto' }, btnSim, btnRun))),
    preview, result);
}
