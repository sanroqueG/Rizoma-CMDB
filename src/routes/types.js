'use strict';
/*
 * Tipos de ativo. Os tipos base (org_id NULL) são comuns a todas as organizações e não se alteram;
 * cada organização pode criar os seus tipos, com os seus campos, sem os impor às outras.
 */
const { fail, toId } = require('../http');
const S = require('../schema');

const MAX_TYPES_PER_ORG = 200;
const FIELD_RE = /^[a-z0-9_]{1,40}$/;

module.exports = function registerTypes(core) {
  const { add, one, all, run, audit, assertAdmin } = core;

  /** Tipos visíveis para uma organização (base + próprios). */
  core.typesFor = (orgId) => all('SELECT * FROM ci_types WHERE org_id IS NULL OR org_id = ? ORDER BY category, name', orgId)
    .map((t) => ({ id: t.id, name: t.name, category: t.category, fields: JSON.parse(t.fields), builtin: t.org_id === null }));
  core.typeVisible = (typeId, orgId) => !!one('SELECT 1 FROM ci_types WHERE id = ? AND (org_id IS NULL OR org_id = ?)', typeId, orgId);

  function readFields(list) {
    const fields = [...new Set((list || []).map((f) => String(f).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s-]+/g, '_')).filter(Boolean))];
    for (const f of fields) if (!FIELD_RE.test(f)) fail(400, `Campo inválido: ${f} (letras minúsculas, números e _)`);
    return fields;
  }
  // Comparação em JS: o NOCASE do SQLite só ignora maiúsculas em ASCII ("CÂMARA" ≠ "câmara")
  const fold = (s) => String(s).trim().toLocaleLowerCase('pt');
  function assertNameFree(orgId, name, exceptId = 0) {
    const clash = all('SELECT id, org_id, name FROM ci_types WHERE (org_id IS NULL OR org_id = ?) AND id <> ?', orgId, exceptId)
      .find((t) => fold(t.name) === fold(name));
    if (clash) fail(409, clash.org_id === null ? `Já existe o tipo base "${name}"` : `Já existe um tipo "${name}"`);
  }
  /** Tipo próprio da organização (os tipos base não se alteram). */
  function ownType(user, id) {
    const t = one('SELECT * FROM ci_types WHERE id = ? AND (org_id IS NULL OR org_id = ?)', toId(id), user.org_id);
    if (!t) fail(404, 'Tipo não encontrado');
    if (t.org_id === null) fail(403, 'Os tipos base não podem ser alterados. Crie um tipo próprio.');
    return t;
  }

  add('GET', '/api/types', ({ user }) => {
    const counts = new Map(all(`SELECT c.type_id, COUNT(*) AS n FROM cis c JOIN clients cl ON cl.id = c.client_id
      WHERE cl.org_id = ? GROUP BY c.type_id`, user.org_id).map((r) => [r.type_id, r.n]));
    return core.typesFor(user.org_id).map((t) => ({ ...t, cis: counts.get(t.id) || 0 }));
  });

  const body = S.obj({
    name: S.str({ max: 60, required: true, label: 'Nome' }),
    category: S.str({ max: 40, required: true, label: 'Categoria' }),
    fields: S.arr(S.str({ max: 40 }), { maxItems: 30 }),
  });

  add('POST', '/api/types', ({ user, body: b }) => {
    assertAdmin(user);
    if (one('SELECT COUNT(*) AS n FROM ci_types WHERE org_id = ?', user.org_id).n >= MAX_TYPES_PER_ORG) fail(402, `Limite de ${MAX_TYPES_PER_ORG} tipos próprios`);
    assertNameFree(user.org_id, b.name);
    const fields = readFields(b.fields);
    const id = Number(run('INSERT INTO ci_types (org_id, name, category, fields) VALUES (?,?,?,?)', user.org_id, b.name, b.category, JSON.stringify(fields)).lastInsertRowid);
    audit('ci_type', id, null, b.name, user.username, 'create', { categoria: b.category, campos: fields }, user.org_id);
    return { id, name: b.name, category: b.category, fields, builtin: false, cis: 0 };
  }, { body });

  add('PUT', '/api/types/:id', ({ user, params, body: b }) => {
    assertAdmin(user);
    const t = ownType(user, params.id);
    assertNameFree(user.org_id, b.name, t.id);
    const fields = readFields(b.fields);
    run('UPDATE ci_types SET name = ?, category = ?, fields = ? WHERE id = ?', b.name, b.category, JSON.stringify(fields), t.id);
    audit('ci_type', t.id, null, b.name, user.username, 'update', { nome: b.name, categoria: b.category, campos: fields }, user.org_id);
    return { ok: true };
  }, { body });

  add('DELETE', '/api/types/:id', ({ user, params }) => {
    assertAdmin(user);
    const t = ownType(user, params.id);
    const n = one('SELECT COUNT(*) AS n FROM cis WHERE type_id = ?', t.id).n;
    if (n) fail(409, `Há ${n} ativo(s) deste tipo. Mude-lhes o tipo antes de o eliminar.`);
    run('DELETE FROM ci_types WHERE id = ?', t.id);
    audit('ci_type', t.id, null, t.name, user.username, 'delete', null, user.org_id);
    return { ok: true };
  });
};
