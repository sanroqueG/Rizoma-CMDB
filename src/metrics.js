'use strict';
/*
 * Métricas no formato Prometheus (texto). Em memória, por instância: o Prometheus junta as instâncias.
 * Pedidos HTTP por rota (o padrão, não o URL, para não multiplicar séries), estado e duração.
 */
const BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function createMetrics() {
  const requests = new Map(); // `${method} ${route} ${code}` → n
  const duration = new Map(); // `${method} ${route}` → { buckets[], sum, count }
  const counters = new Map(); // nome → n (ex.: rizoma_jobs_total{kind,result})
  const started = Date.now();

  function observe(method, route, status, seconds) {
    const k = `${method}\u0000${route}\u0000${status}`;
    requests.set(k, (requests.get(k) || 0) + 1);
    const dk = `${method}\u0000${route}`;
    let d = duration.get(dk);
    if (!d) { d = { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 }; duration.set(dk, d); }
    BUCKETS.forEach((b, i) => { if (seconds <= b) d.buckets[i] += 1; });
    d.sum += seconds;
    d.count += 1;
  }
  function inc(name, labels = {}) {
    const k = `${name}${fmtLabels(labels)}`;
    counters.set(k, (counters.get(k) || 0) + 1);
  }

  /** gauges: [{ name, help, value, labels? }] calculados no momento (ex.: n.º de organizações). */
  function render(gauges = []) {
    const out = [];
    out.push('# HELP rizoma_http_requests_total Pedidos HTTP por rota e estado.', '# TYPE rizoma_http_requests_total counter');
    for (const [k, n] of requests) {
      const [method, route, status] = k.split('\u0000');
      out.push(`rizoma_http_requests_total${fmtLabels({ method, route, status })} ${n}`);
    }
    out.push('# HELP rizoma_http_request_duration_seconds Duração dos pedidos HTTP.', '# TYPE rizoma_http_request_duration_seconds histogram');
    for (const [k, d] of duration) {
      const [method, route] = k.split('\u0000');
      BUCKETS.forEach((b, i) => out.push(`rizoma_http_request_duration_seconds_bucket${fmtLabels({ method, route, le: String(b) })} ${d.buckets[i]}`));
      out.push(`rizoma_http_request_duration_seconds_bucket${fmtLabels({ method, route, le: '+Inf' })} ${d.count}`);
      out.push(`rizoma_http_request_duration_seconds_sum${fmtLabels({ method, route })} ${d.sum.toFixed(6)}`);
      out.push(`rizoma_http_request_duration_seconds_count${fmtLabels({ method, route })} ${d.count}`);
    }
    const names = new Set([...counters.keys()].map((k) => k.replace(/\{.*$/, '')));
    for (const name of names) {
      out.push(`# TYPE ${name} counter`);
      for (const [k, n] of counters) if (k.replace(/\{.*$/, '') === name) out.push(`${k} ${n}`);
    }
    out.push('# TYPE rizoma_uptime_seconds gauge', `rizoma_uptime_seconds ${Math.round((Date.now() - started) / 1000)}`);
    for (const g of gauges) {
      out.push(`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} gauge`, `${g.name}${fmtLabels(g.labels || {})} ${g.value}`);
    }
    return `${out.join('\n')}\n`;
  }
  return { observe, inc, render };
}

function fmtLabels(labels) {
  const e = Object.entries(labels);
  if (!e.length) return '';
  return `{${e.map(([k, v]) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`).join(',')}}`;
}

module.exports = { createMetrics };
