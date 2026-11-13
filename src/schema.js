'use strict';
/*
 * Validação declarativa (sem dependências). Uma rota declara o esquema do corpo:
 *
 *   add('POST', '/api/x', handler, { body: obj({ name: str({ max: 120, required: true, label: 'Nome' }) }) })
 *
 * O router valida antes de chamar o handler (erros 400 consistentes, em português) e o mesmo esquema gera a
 * documentação OpenAPI (toJsonSchema). Os campos não declarados são descartados.
 */
const { HttpError } = require('./http');

const bad = (msg) => { throw new HttpError(400, msg); };
const name = (s, path) => s.label || path || 'valor';
const empty = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

function str(o = {}) { return { type: 'string', ...o }; }
function int(o = {}) { return { type: 'integer', ...o }; }
function num(o = {}) { return { type: 'number', ...o }; }
function bool(o = {}) { return { type: 'boolean', ...o }; }
function date(o = {}) { return { type: 'string', format: 'date', ...o }; }
function email(o = {}) { return { type: 'string', format: 'email', max: 160, ...o }; }
function url(o = {}) { return { type: 'string', format: 'uri', max: 500, ...o }; }
function arr(items, o = {}) { return { type: 'array', items, ...o }; }
function obj(props, o = {}) { return { type: 'object', props, ...o }; }
/** Objeto livre (chaves e valores não declarados, ex.: atributos de um ativo). */
function dict(o = {}) { return { type: 'object', props: {}, free: true, ...o }; }
/** Um de vários esquemas (o primeiro que valida). */
function anyOf(options, o = {}) { return { type: 'anyOf', options, ...o }; }

/** Valida e normaliza `value` segundo `s`. Devolve o valor limpo (ou undefined se ausente e opcional). */
function validate(s, value, path = '') {
  if (empty(value)) {
    if (s.required) bad(`${name(s, path)} é obrigatório`);
    return s.default !== undefined ? s.default : (value === null || (typeof value === 'string') ? null : undefined);
  }
  switch (s.type) {
    case 'string': {
      if (typeof value !== 'string' && typeof value !== 'number') bad(`${name(s, path)} deve ser texto`);
      let v = String(value).trim();
      if (s.max && v.length > s.max) v = s.truncate === false ? bad(`${name(s, path)}: máximo de ${s.max} caracteres`) : v.slice(0, s.max);
      if (s.min && v.length < s.min) bad(`${name(s, path)}: mínimo de ${s.min} caracteres`);
      if (s.enum && !s.enum.includes(v)) bad(`${name(s, path)} inválido`);
      if (s.pattern && !new RegExp(s.pattern).test(v)) bad(s.patternMessage || `${name(s, path)} inválido`);
      if (s.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) bad(`${name(s, path)} deve ter o formato AAAA-MM-DD`);
      if (s.format === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) bad(`${name(s, path)}: email inválido`);
      if (s.format === 'uri' && !/^https?:\/\//i.test(v)) bad(`${name(s, path)} tem de começar por http:// ou https://`);
      return v;
    }
    case 'integer':
    case 'number': {
      const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
      if (!Number.isFinite(n) || (s.type === 'integer' && !Number.isInteger(n))) bad(`${name(s, path)} inválido`);
      if (s.minimum !== undefined && n < s.minimum) bad(`${name(s, path)} inválido`);
      if (s.maximum !== undefined && n > s.maximum) bad(`${name(s, path)} inválido`);
      return n;
    }
    case 'boolean':
      return value === true || value === 'true' || value === 1 || value === '1' || value === 'on';
    case 'array': {
      if (!Array.isArray(value)) bad(`${name(s, path)} deve ser uma lista`);
      if (s.maxItems && value.length > s.maxItems) bad(`${name(s, path)}: máximo de ${s.maxItems} elementos`);
      return value.map((v, i) => validate(s.items, v, `${path}[${i}]`));
    }
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) bad(`${name(s, path)} deve ser um objeto`);
      if (s.free) return value;
      const out = {};
      for (const [k, ps] of Object.entries(s.props)) {
        const has = Object.prototype.hasOwnProperty.call(value, k);
        if (!has && !ps.required && ps.default === undefined) continue;
        const v = validate(ps, value[k], path ? `${path}.${k}` : k);
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    case 'anyOf': {
      let last;
      for (const o of s.options) {
        try { return validate(o, value, path); } catch (e) { last = e; }
      }
      throw last;
    }
    default:
      return value;
  }
}

/** JSON Schema (para OpenAPI 3.1) a partir de um esquema. */
function toJsonSchema(s) {
  const base = {};
  if (s.description || s.label) base.description = s.description || s.label;
  switch (s.type) {
    case 'string': return { ...base, type: 'string', ...(s.max && { maxLength: s.max }), ...(s.enum && { enum: s.enum }), ...(s.format && { format: s.format }), ...(s.example !== undefined && { example: s.example }) };
    case 'integer':
    case 'number': return { ...base, type: s.type, ...(s.minimum !== undefined && { minimum: s.minimum }), ...(s.maximum !== undefined && { maximum: s.maximum }) };
    case 'boolean': return { ...base, type: 'boolean' };
    case 'array': return { ...base, type: 'array', items: toJsonSchema(s.items), ...(s.maxItems && { maxItems: s.maxItems }) };
    case 'object': {
      const required = Object.entries(s.props).filter(([, p]) => p.required).map(([k]) => k);
      if (s.free) return { ...base, type: 'object', additionalProperties: true };
      return { ...base, type: 'object', properties: Object.fromEntries(Object.entries(s.props).map(([k, p]) => [k, toJsonSchema(p)])), ...(required.length && { required }) };
    }
    case 'anyOf': return { ...base, anyOf: s.options.map(toJsonSchema) };
    default: return base;
  }
}

module.exports = { str, int, num, bool, date, email, url, arr, obj, dict, anyOf, validate, toJsonSchema };
