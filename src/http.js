'use strict';
/* Constantes, erros HTTP e utilitários de validação partilhados pelas rotas. */

// ---------------------------------------------------------------- constantes
const STATUSES = ['planeado', 'em_stock', 'em_producao', 'em_manutencao', 'abatido'];
const CRITICALITIES = ['baixa', 'media', 'alta', 'critica'];
const ENVIRONMENTS = ['producao', 'qualidade', 'desenvolvimento'];
const REL_TYPES = ['depende_de', 'corre_em', 'alojado_em', 'ligado_a', 'usa'];
const ROLES = ['admin', 'tech', 'client'];
const CI_TEXT_FIELDS = ['name', 'hostname', 'ip_address', 'serial_number', 'asset_tag', 'manufacturer',
  'model', 'os', 'owner', 'purchase_date', 'warranty_end', 'notes', 'environment'];
const CSV_COLUMNS = ['id', 'client_name', 'site_name', 'type_name', 'name', 'status', 'environment', 'criticality',
  'hostname', 'ip_address', 'serial_number', 'asset_tag', 'manufacturer', 'model', 'os', 'owner',
  'purchase_date', 'warranty_end', 'source', 'last_seen', 'updated_at'];
const SESSION_TTL_MS = 8 * 3600 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.ps1': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

// ---------------------------------------------------------------- utilitários
function toId(v, label = 'id') {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) fail(400, `${label} inválido`);
  return n;
}
function str(v, max = 255) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s.slice(0, max);
}
function reqStr(v, label, max) {
  const s = str(v, max);
  if (!s) fail(400, `${label} é obrigatório`);
  return s;
}
function oneOf(v, list, label) {
  if (!list.includes(v)) fail(400, `${label} inválido`);
  return v;
}
function isoDate(v, label) {
  const s = str(v, 10);
  if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) fail(400, `${label} deve ter o formato AAAA-MM-DD`);
  return s;
}
function cleanAttributes(obj) {
  if (obj === null || obj === undefined) return {};
  if (typeof obj !== 'object' || Array.isArray(obj)) fail(400, 'attributes deve ser um objeto');
  const out = {};
  for (const [k, v] of Object.entries(obj).slice(0, 100)) {
    const key = String(k).trim().slice(0, 64);
    if (!key || v === null || v === undefined || v === '') continue;
    out[key] = typeof v === 'number' || typeof v === 'boolean' ? v : String(v).slice(0, 1000);
  }
  return out;
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // evita injeção de fórmulas no Excel
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Pedido demasiado grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

module.exports = {
  STATUSES, CRITICALITIES, ENVIRONMENTS, REL_TYPES, ROLES, CI_TEXT_FIELDS, CSV_COLUMNS, SESSION_TTL_MS, LOGIN_WINDOW_MS, LOGIN_MAX_FAILS, MIME, SECURITY_HEADERS, HttpError, fail, toId, str, reqStr, oneOf, isoDate, cleanAttributes, parseCookies, csvCell, readBody,
};
