'use strict';
/*
 * Esquemas dos pedidos da aplicação, por rota ("MÉTODO /caminho"). O router valida o corpo antes do handler:
 * tipos, tamanhos, enumerações e formatos ficam declarados aqui; as regras de negócio (ex.: fim depois do
 * início, cliente da mesma organização) continuam nas rotas. As rotas da API pública declaram o esquema
 * na própria rota (ver api-schemas.js).
 */
const { str, int, num, bool, date, email, url, arr, obj, dict, anyOf } = require('./schema');
const { STATUSES, CRITICALITIES, ENVIRONMENTS, REL_TYPES, ROLES } = require('./http');

const id = (label) => int({ minimum: 1, label });
const optId = (label) => anyOf([id(label), str({ max: 0 })]);
const text = (max = 255, label) => str({ max, label });

const ci = (partial) => obj({
  client_id: partial ? id('Cliente') : id('Cliente'),
  name: str({ max: 255, label: 'Nome' }),
  type_id: id('Tipo'),
  site_id: optId('Local'),
  status: str({ enum: STATUSES, label: 'Estado' }),
  criticality: str({ enum: CRITICALITIES, label: 'Criticidade' }),
  environment: str({ enum: ENVIRONMENTS, label: 'Ambiente' }),
  hostname: text(), ip_address: text(), serial_number: text(), asset_tag: text(), manufacturer: text(), model: text(),
  os: text(), owner: text(), notes: text(5000),
  purchase_date: date({ label: 'Data de compra' }),
  warranty_end: date({ label: 'Fim de garantia' }),
  attributes: dict(),
});

const contract = obj({
  client_id: id('Cliente'),
  name: str({ max: 160, label: 'Nome' }),
  kind: str({ enum: ['licenca', 'suporte', 'manutencao', 'subscricao', 'garantia', 'outsourcing', 'outro'], label: 'Tipo de contrato' }),
  status: str({ enum: ['ativo', 'terminado', 'cancelado'], label: 'Estado' }),
  vendor: text(160), reference: text(160), owner: text(160), notes: text(5000),
  start_date: date({ label: 'Data de início' }),
  end_date: date({ label: 'Data de fim' }),
  auto_renew: bool(),
  billing: str({ enum: ['mensal', 'trimestral', 'anual', 'unico'], label: 'Periodicidade' }),
  cost: num({ minimum: 0, maximum: 1e12, label: 'Custo' }),
  quantity: int({ minimum: 0, maximum: 1e9, label: 'Quantidade' }),
  notice_days: int({ minimum: 0, maximum: 3650, label: 'Pré-aviso (dias)' }),
  ci_ids: arr(id('Ativo'), { maxItems: 5000 }),
});

const client = obj({
  name: str({ max: 120, label: 'Nome' }),
  code: str({ max: 12, label: 'Código' }),
  contact_name: text(120),
  contact_email: anyOf([email({ label: 'Email' }), str({ max: 0 })]),
  notes: text(5000),
});

const user = obj({
  username: str({ max: 60, label: 'Utilizador' }),
  name: str({ max: 120, label: 'Nome' }),
  role: str({ enum: ROLES, label: 'Perfil' }),
  email: anyOf([email({ label: 'Email' }), str({ max: 0 })]),
  password: str({ max: 200, truncate: false, label: 'Password' }),
  client_id: optId('Cliente'),
  client_ids: arr(id('Cliente'), { maxItems: 5000 }),
  active: bool(),
  must_change_password: bool(),
});

const site = obj({ name: str({ max: 120, label: 'Nome' }), address: text(255) });
const ticket = obj({
  system: str({ max: 40, required: true, label: 'Sistema' }),
  external_id: str({ max: 80, required: true, label: 'Nº do ticket' }),
  title: text(300), status: text(60), priority: text(40),
  url: anyOf([url({ label: 'URL do ticket' }), str({ max: 0 })]),
  closed: bool(),
});
const orgAdmin = {
  admin_username: str({ max: 60, required: true, label: 'Utilizador' }),
  admin_name: str({ max: 120, required: true, label: 'Nome' }),
  admin_email: anyOf([email({ label: 'Email' }), str({ max: 0 })]),
  admin_password: str({ max: 200, truncate: false, required: true, label: 'Password' }),
};
const limit = (label) => anyOf([int({ minimum: 0, maximum: 1e7, label }), str({ max: 0 })]);
const orgLimits = { max_clients: limit('Máx. clientes'), max_cis: limit('Máx. ativos'), max_users: limit('Máx. utilizadores') };

const BODY_SCHEMAS = {
  'POST /api/cis': ci(false),
  'PUT /api/cis/:id': ci(true),
  'POST /api/relationships': obj({ source_id: id('Origem'), target_id: id('Destino'), type: str({ enum: REL_TYPES, required: true, label: 'Tipo de relação' }) }),
  'POST /api/contracts': contract,
  'PUT /api/contracts/:id': contract,
  'POST /api/clients': client,
  'PUT /api/clients/:id': client,
  'POST /api/clients/:id/sites': site,
  'PUT /api/sites/:id': site,
  'POST /api/users': user,
  'PUT /api/users/:id': user,
  'POST /api/cis/:id/tickets': ticket,
  'POST /api/signup': obj({
    organization: str({ max: 120, required: true, label: 'Empresa' }),
    name: str({ max: 120, required: true, label: 'Nome' }),
    username: str({ max: 60, required: true, label: 'Utilizador' }),
    email: anyOf([email({ label: 'Email' }), str({ max: 0 })]),
    password: str({ max: 200, truncate: false, required: true, label: 'Password' }),
  }),
  'PUT /api/org': obj({ name: str({ max: 120, required: true, label: 'Nome da organização' }) }),
  'POST /api/platform/orgs': obj({ name: str({ max: 120, required: true, label: 'Nome da organização' }), plan: text(40), ...orgLimits, ...orgAdmin }),
  'PUT /api/platform/orgs/:id': obj({ name: str({ max: 120, label: 'Nome' }), plan: text(40), status: str({ enum: ['active', 'suspended'], label: 'Estado' }), ...orgLimits }),
  'POST /api/me/password': obj({ current: str({ max: 200, truncate: false }), password: str({ max: 200, truncate: false }) }),
  'PUT /api/me/notifications': obj({ digest: bool() }),
  'POST /api/login': obj({ username: str({ max: 60 }), password: str({ max: 200, truncate: false }) }),
  'POST /api/login/mfa': obj({ mfa_token: str({ max: 200, truncate: false }), code: str({ max: 20, truncate: false }) }),
  'POST /api/me/2fa/enable': obj({ code: str({ max: 20, truncate: false }) }),
  'POST /api/me/2fa/disable': obj({ password: str({ max: 200, truncate: false }) }),
  'POST /api/me/2fa/recovery-codes': obj({ code: str({ max: 20, truncate: false }) }),
  'POST /api/import': obj({
    client_id: id('Cliente'),
    rows: arr(dict(), { maxItems: 5000, label: 'Linhas' }),
    dry_run: bool(), update: bool(), create_sites: bool(),
  }),
  'PUT /api/clients/:id/connector': obj({
    tenant_id: str({ max: 100, required: true, label: 'Tenant ID' }),
    app_id: str({ max: 100, required: true, label: 'Application (client) ID' }),
    secret: str({ max: 500, truncate: false }),
    enabled: bool(),
    options: obj({ licenses: bool(), intune: bool(), azure: bool() }),
  }),
};

module.exports = { BODY_SCHEMAS };
