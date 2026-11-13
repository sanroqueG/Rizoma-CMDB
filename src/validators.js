'use strict';
/* Validação de dados de entrada sem acesso à base de dados (usada pelas rotas e pelas tarefas em segundo plano). */
const {
  STATUSES, CRITICALITIES, ENVIRONMENTS, CI_TEXT_FIELDS, fail, toId, str, oneOf, isoDate, cleanAttributes,
} = require('./http');

/** Campos de um ativo (CI) a partir do corpo do pedido; só os presentes. */
function readCiInput(body) {
  const out = {};
  for (const f of CI_TEXT_FIELDS) if (f in body) out[f] = str(body[f], f === 'notes' ? 5000 : 255);
  if ('name' in out && !out.name) fail(400, 'Nome é obrigatório');
  if ('type_id' in body) out.type_id = toId(body.type_id, 'Tipo');
  if ('site_id' in body) out.site_id = body.site_id ? toId(body.site_id, 'Local') : null;
  if ('status' in body) out.status = oneOf(body.status, STATUSES, 'Estado');
  if ('criticality' in body) out.criticality = oneOf(body.criticality, CRITICALITIES, 'Criticidade');
  if (out.environment) oneOf(out.environment, ENVIRONMENTS, 'Ambiente');
  if ('purchase_date' in out) out.purchase_date = isoDate(out.purchase_date, 'Data de compra');
  if ('warranty_end' in out) out.warranty_end = isoDate(out.warranty_end, 'Fim de garantia');
  if ('attributes' in body) out.attributes = JSON.stringify(cleanAttributes(body.attributes));
  return out;
}

module.exports = { readCiInput };
