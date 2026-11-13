'use strict';
/*
 * Registo de eventos. CMDB_LOG_FORMAT=json produz uma linha JSON por evento (para Loki, Elastic, Datadog…);
 * por omissão, texto legível. CMDB_LOG_LEVEL: debug | info | warn | error (omissão: info).
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(env = process.env, out = process.stdout, errOut = process.stderr) {
  const json = env.CMDB_LOG_FORMAT === 'json';
  const min = LEVELS[env.CMDB_LOG_LEVEL] || LEVELS.info;

  function write(level, msg, fields = {}) {
    if (LEVELS[level] < min) return;
    const stream = LEVELS[level] >= LEVELS.warn ? errOut : out;
    /** @type {Record<string, any>} */
    const f = { ...fields };
    if (f.err instanceof Error) f.err = { message: f.err.message, stack: f.err.stack };
    if (json) {
      stream.write(`${JSON.stringify({ time: new Date().toISOString(), level, msg, ...f })}\n`);
    } else {
      const extra = Object.entries(f).filter(([k]) => k !== 'err')
        .map(([k, v]) => `${k}=${typeof v === 'string' && !/\s/.test(v) ? v : JSON.stringify(v)}`).join(' ');
      stream.write(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${extra ? ` ${extra}` : ''}\n`);
      if (f.err && f.err.stack) stream.write(`${f.err.stack}\n`);
    }
  }
  return {
    debug: (m, f) => write('debug', m, f), info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f), error: (m, f) => write('error', m, f),
  };
}

/** Envolve o handler HTTP para registar cada pedido à API (método, caminho, estado, duração). */
function withRequestLog(handler, log) {
  return (req, res) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const p = (req.url || '').split('?')[0];
      if (!p.startsWith('/api/') || p === '/api/health') return;
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const fields = { method: req.method, path: p, status: res.statusCode, ms: Math.round(ms * 10) / 10, ip: req.socket.remoteAddress };
      if (res.statusCode >= 500) log.error('pedido', fields);
      else if (res.statusCode >= 400 && res.statusCode !== 401) log.info('pedido', fields);
      else log.debug('pedido', fields);
    });
    return handler(req, res);
  };
}

module.exports = { createLogger, withRequestLog };
