'use strict';
/* Mapa de relações em SVG (layout em camadas, sem dependências).
   Convenção: "origem depende do destino" → dependentes à esquerda, dependências à direita. */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const NODE_W = 184;
  const NODE_H = 46;
  const COL_W = 250;
  const ROW_H = 64;
  const PAD = 24;

  function el(tag, attrs, ...kids) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null) e.setAttribute(k, v);
    kids.forEach((k) => e.append(k));
    return e;
  }
  const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  /** Nível de cada nó: usa node.level se existir; senão, a maior distância até uma folha (sem dependências). */
  function computeLevels(nodes, edges) {
    if (nodes.every((n) => typeof n.level === 'number')) return new Map(nodes.map((n) => [n.id, n.level]));
    const out = new Map(nodes.map((n) => [n.id, []]));
    edges.forEach((e) => out.get(e.source) && out.get(e.source).push(e.target));
    const height = new Map();
    const visiting = new Set();
    const h = (id) => {
      if (height.has(id)) return height.get(id);
      if (visiting.has(id)) return 0; // ciclo
      visiting.add(id);
      let best = 0;
      for (const t of out.get(id) || []) best = Math.max(best, h(t) + 1);
      visiting.delete(id);
      height.set(id, best);
      return best;
    };
    nodes.forEach((n) => h(n.id));
    const max = Math.max(0, ...height.values());
    return new Map(nodes.map((n) => [n.id, max - height.get(n.id)]));
  }

  function layout(nodes, edges) {
    const level = computeLevels(nodes, edges);
    const minL = Math.min(...level.values());
    const cols = new Map();
    nodes.forEach((n) => {
      const c = level.get(n.id) - minL;
      if (!cols.has(c)) cols.set(c, []);
      cols.get(c).push(n);
    });
    const colKeys = [...cols.keys()].sort((a, b) => a - b);
    colKeys.forEach((k) => cols.get(k).sort((a, b) => a.name.localeCompare(b.name)));
    // Heurística do baricentro (2 passagens) para reduzir cruzamentos
    const neighbors = new Map(nodes.map((n) => [n.id, []]));
    edges.forEach((e) => { neighbors.get(e.source)?.push(e.target); neighbors.get(e.target)?.push(e.source); });
    const rowOf = new Map();
    const index = () => colKeys.forEach((k) => cols.get(k).forEach((n, i) => rowOf.set(n.id, i)));
    index();
    for (const order of [colKeys, [...colKeys].reverse()]) {
      for (const k of order) {
        const bary = (n) => {
          const ns = neighbors.get(n.id).filter((id) => rowOf.has(id));
          return ns.length ? ns.reduce((s, id) => s + rowOf.get(id), 0) / ns.length : rowOf.get(n.id);
        };
        cols.get(k).sort((a, b) => bary(a) - bary(b));
        index();
      }
    }
    const maxRows = Math.max(...colKeys.map((k) => cols.get(k).length));
    const pos = new Map();
    colKeys.forEach((k, ci) => {
      const list = cols.get(k);
      const offset = ((maxRows - list.length) * ROW_H) / 2;
      list.forEach((n, i) => pos.set(n.id, { x: PAD + ci * COL_W, y: PAD + offset + i * ROW_H }));
    });
    return { pos, width: PAD * 2 + (colKeys.length - 1) * COL_W + NODE_W, height: PAD * 2 + maxRows * ROW_H - (ROW_H - NODE_H) };
  }

  /**
   * @param data   { nodes: [{id,name,type_name,status,criticality,level?}], edges: [{source,target,type}] }
   * @param opts   { centerId, relLabels, onNavigate(id) }
   */
  function render(data, opts = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'graph-wrap';
    if (!data.nodes.length) {
      wrap.textContent = 'Sem relações para mostrar.';
      wrap.classList.add('muted');
      return wrap;
    }
    const { pos, width, height } = layout(data.nodes, data.edges);
    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'graph', role: 'img', 'aria-label': 'Mapa de relações' });
    svg.append(el('defs', {}, el('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: '10', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' },
      el('path', { d: 'M0 0L10 5L0 10z', class: 'garrow' }))));

    const edgeLayer = el('g', {});
    const showLabels = data.edges.length <= 40;
    for (const e of data.edges) {
      const a = pos.get(e.source);
      const b = pos.get(e.target);
      if (!a || !b) continue;
      const x1 = a.x + NODE_W; const y1 = a.y + NODE_H / 2;
      const x2 = b.x; const y2 = b.y + NODE_H / 2;
      const forward = x2 > x1;
      const dx = forward ? Math.max(40, (x2 - x1) / 2) : 90;
      const d = forward
        ? `M${x1} ${y1}C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`
        : `M${x1} ${y1}C${x1 + dx} ${y1 + 60} ${x2 - dx} ${y2 + 60} ${x2} ${y2}`;
      const label = (opts.relLabels && opts.relLabels[e.type]) || e.type;
      const p = el('path', { d, class: 'gedge', 'marker-end': 'url(#arrow)' }, el('title', {}, label));
      edgeLayer.append(p);
      if (showLabels && forward) {
        edgeLayer.append(el('text', { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 4, class: 'glabel', 'text-anchor': 'middle' }, label));
      }
    }
    svg.append(edgeLayer);

    for (const n of data.nodes) {
      const p = pos.get(n.id);
      const cls = ['gnode', `crit-${n.criticality}`, n.id === opts.centerId ? 'gcenter' : '', n.status === 'abatido' ? 'gretired' : ''].join(' ');
      const g = el('a', { href: `#/ativos/${n.id}`, class: cls },
        el('title', {}, `${n.name} — ${n.type_name}`),
        el('rect', { x: p.x, y: p.y, width: NODE_W, height: NODE_H, rx: 2 }),
        el('rect', { x: p.x, y: p.y, width: 4, height: NODE_H, rx: 0, class: 'gcrit' }),
        el('text', { x: p.x + 14, y: p.y + 19, class: 'gname' }, trunc(n.name, 24)),
        el('text', { x: p.x + 14, y: p.y + 35, class: 'gtype' }, trunc(n.type_name, 28)));
      svg.append(g);
    }
    wrap.append(svg);
    return wrap;
  }

  window.Graph = { render, layout };
}());
