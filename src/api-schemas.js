'use strict';
/* Esquemas da API pública de integração (/api/v1). Validam os pedidos e geram a documentação OpenAPI. */
const { str, int, bool, url, arr, obj, dict, anyOf } = require('./schema');

const asset = obj({
  external_id: str({ max: 300, description: 'Identificador estável na origem (ex.: UUID do equipamento). É a primeira chave de reconciliação.' }),
  name: str({ max: 255, description: 'Nome do ativo (por omissão, o hostname).' }),
  type: str({ max: 120, description: 'Tipo de ativo, ex.: "Portátil", "Servidor", "Posto de trabalho".', example: 'Portátil' }),
  site: str({ max: 120, description: 'Nome de um local já existente no cliente.' }),
  hostname: str({ max: 255, example: 'PC-001' }),
  ip_address: str({ max: 255, example: '10.0.0.5' }),
  serial_number: str({ max: 255, description: 'Segunda chave de reconciliação.', example: '5CG1234XYZ' }),
  manufacturer: str({ max: 255 }),
  model: str({ max: 255 }),
  os: str({ max: 255, example: 'Windows 11 Pro' }),
  attributes: dict({ description: 'Atributos livres (até 100), ex.: { "ram_gb": 16 }.' }),
}, { description: 'Ativo descoberto' });

const ingest = anyOf([
  obj({ assets: arr(asset, { maxItems: 500, required: true, label: 'assets' }) }, { description: 'Vários ativos (máx. 500).' }),
  asset,
], { description: 'Um ativo, ou { "assets": [ … ] }.' });

const ciRef = anyOf([
  str({ max: 255, description: 'Texto: procura em hostname, nº de série, etiqueta, nome e IP.' }),
  obj({ id: int({ minimum: 1 }), hostname: str({ max: 255 }), serial_number: str({ max: 255 }), asset_tag: str({ max: 255 }), name: str({ max: 255 }) }),
]);

const ticket = obj({
  system: str({ max: 40, required: true, label: 'Sistema', example: 'GLPI' }),
  external_id: str({ max: 80, required: true, label: 'ID do ticket', example: '4711' }),
  title: str({ max: 300 }),
  status: str({ max: 60, description: 'Estados como "Resolvido", "Fechado", "Closed" ou "Resolved" fecham o ticket.' }),
  priority: str({ max: 40 }),
  url: url({ label: 'URL do ticket' }),
  closed: bool({ description: 'Força o estado aberto/fechado.' }),
  cis: arr(ciRef, { maxItems: 50, description: 'Ativos afetados.' }),
});

module.exports = { asset, ingest, ticket };
