#!/usr/bin/env node
'use strict';
/* Cria dados de demonstração (apenas se a BD ainda não tiver clientes). */
const path = require('node:path');
const { openDb } = require('../src/db');
const { hashPassword } = require('../src/auth');

const DB_FILE = process.env.CMDB_DB || path.join(__dirname, '..', 'data', 'cmdb.db');
const db = openDb(DB_FILE);

if (db.prepare('SELECT COUNT(*) AS n FROM clients').get().n > 0) {
  console.log('A BD já tem clientes — dados de demonstração não foram criados.');
  process.exit(0);
}

const type = (name) => db.prepare('SELECT id FROM ci_types WHERE name = ?').get(name).id;
const ins = (sql, ...p) => Number(db.prepare(sql).run(...p).lastInsertRowid);
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

db.exec('BEGIN');
// Organização de demonstração (a primeira; criada se a BD estiver vazia)
let org = db.prepare('SELECT id FROM organizations ORDER BY id LIMIT 1').get();
if (!org) org = { id: ins("INSERT INTO organizations (name, slug) VALUES ('Organização principal', 'principal')") };
const ORG = org.id;
const clients = {};
for (const [name, code, contact, email] of [
  ['Acme Logística, S.A.', 'ACME', 'Rita Fonseca', 'it@acme.example'],
  ['Clínica Boa Saúde', 'CBS', 'Nuno Pires', 'informatica@cbs.example'],
  ['Gabinete Contas Certas', 'GCC', 'Marta Lopes', 'geral@gcc.example'],
]) clients[code] = ins('INSERT INTO clients (org_id, name, code, contact_name, contact_email) VALUES (?,?,?,?,?)', ORG, name, code, contact, email);

const site = (c, name, addr) => ins('INSERT INTO sites (client_id, name, address) VALUES (?,?,?)', clients[c], name, addr);
const acmeLx = site('ACME', 'Sede Lisboa', 'Av. da Liberdade, Lisboa');
const acmePt = site('ACME', 'Armazém Porto', 'Zona Industrial, Maia');
const cbs = site('CBS', 'Clínica Braga', 'Rua do Souto, Braga');
const gcc = site('GCC', 'Escritório Coimbra', 'Praça da República, Coimbra');

function ci(c, siteId, typeName, name, extra = {}) {
  const d = { client_id: clients[c], site_id: siteId, type_id: type(typeName), name, ...extra };
  if (d.attributes) d.attributes = JSON.stringify(d.attributes);
  const cols = Object.keys(d);
  return ins(`INSERT INTO cis (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...Object.values(d));
}
const rel = (s, t, ty) => ins('INSERT INTO relationships (source_id, target_id, type) VALUES (?,?,?)', s, t, ty);

// ACME
const fw = ci('ACME', acmeLx, 'Firewall', 'FW-LX-01', { manufacturer: 'Fortinet', model: 'FortiGate 60F', ip_address: '10.10.0.1', serial_number: 'FGT60F0001', criticality: 'critica', environment: 'producao', warranty_end: day(45), attributes: { firmware: '7.4.3' } });
const sw = ci('ACME', acmeLx, 'Equipamento de rede', 'SW-LX-CORE', { manufacturer: 'HPE Aruba', model: '6100 48G', ip_address: '10.10.0.2', serial_number: 'CN12345678', criticality: 'alta', environment: 'producao', attributes: { portas: 48 } });
const hv = ci('ACME', acmeLx, 'Servidor', 'HV-LX-01', { manufacturer: 'Dell', model: 'PowerEdge R650', ip_address: '10.10.1.10', serial_number: 'DL7XK92', os: 'Windows Server 2022 Datacenter', criticality: 'critica', environment: 'producao', warranty_end: day(-10), purchase_date: '2021-03-15', attributes: { cpu: '2x Xeon Silver 4314', ram_gb: 256, disco_gb: 4000 } });
const vmApp = ci('ACME', acmeLx, 'Máquina virtual', 'SRV-ERP-APP', { ip_address: '10.10.1.21', os: 'Windows Server 2022', criticality: 'alta', environment: 'producao', attributes: { vcpu: 8, ram_gb: 32, hypervisor: 'Hyper-V' } });
const vmDb = ci('ACME', acmeLx, 'Máquina virtual', 'SRV-ERP-SQL', { ip_address: '10.10.1.22', os: 'Windows Server 2022', criticality: 'critica', environment: 'producao', attributes: { vcpu: 8, ram_gb: 64, hypervisor: 'Hyper-V' } });
const sql = ci('ACME', acmeLx, 'Base de dados', 'SQL ERP', { criticality: 'critica', environment: 'producao', attributes: { motor: 'SQL Server', versao: '2019' } });
const erp = ci('ACME', acmeLx, 'Aplicação', 'ERP Primavera', { criticality: 'critica', environment: 'producao', owner: 'Direção Financeira', attributes: { versao: 'v10', url: 'https://erp.acme.example' } });
const svc = ci('ACME', null, 'Serviço de negócio', 'Faturação e Logística', { criticality: 'critica', owner: 'Rita Fonseca', attributes: { sla: '99,5% · 8x5' } });
ci('ACME', acmeLx, 'Licença', 'Microsoft 365 Business Premium', { attributes: { fornecedor: 'Microsoft', quantidade: 45 }, warranty_end: day(70) });
ci('ACME', null, 'Recurso cloud', 'Backup Azure (Recovery Vault)', { criticality: 'alta', attributes: { fornecedor: 'Azure', regiao: 'West Europe', subscricao: 'ACME-PROD' } });
for (let i = 1; i <= 8; i++) {
  ci('ACME', i <= 5 ? acmeLx : acmePt, i % 3 ? 'Portátil' : 'Posto de trabalho', `ACME-PC-${String(i).padStart(3, '0')}`, {
    hostname: `ACME-PC-${String(i).padStart(3, '0')}`, manufacturer: i % 2 ? 'Lenovo' : 'HP', model: i % 2 ? 'ThinkPad T14 G4' : 'EliteBook 840 G10',
    serial_number: `PF${100000 + i * 37}`, os: 'Windows 11 Pro (10.0.22631)', ip_address: `10.10.20.${30 + i}`,
    source: 'agent', external_id: `demo-uuid-acme-${i}`,
    last_seen: i === 7 ? '2026-08-01 09:00:00' : new Date().toISOString().slice(0, 19).replace('T', ' '),
    warranty_end: i === 2 ? day(20) : day(400 + i * 30), attributes: { cpu: 'Intel Core i5-1345U', ram_gb: 16, disco_gb: 512 },
  });
}
ci('ACME', acmePt, 'Impressora', 'PRT-PT-01', { manufacturer: 'Brother', model: 'MFC-L8900CDW', ip_address: '10.20.0.50', status: 'em_manutencao' });

rel(vmApp, hv, 'alojado_em'); rel(vmDb, hv, 'alojado_em'); rel(hv, sw, 'ligado_a'); rel(sw, fw, 'ligado_a');
rel(sql, vmDb, 'corre_em'); rel(erp, vmApp, 'corre_em'); rel(erp, sql, 'depende_de'); rel(svc, erp, 'usa');

// Clínica
const nas = ci('CBS', cbs, 'Servidor', 'NAS-BRG-01', { manufacturer: 'Synology', model: 'RS1221+', serial_number: 'SYN2211A', ip_address: '192.168.1.5', criticality: 'alta', warranty_end: day(15) });
const app = ci('CBS', cbs, 'Aplicação', 'Software Clínico', { criticality: 'critica', attributes: { versao: '2026.2' } });
ci('CBS', cbs, 'Firewall', 'FW-BRG', { manufacturer: 'Sophos', model: 'XGS 107', ip_address: '192.168.1.1' });
for (let i = 1; i <= 4; i++) ci('CBS', cbs, 'Posto de trabalho', `CBS-REC-0${i}`, { hostname: `CBS-REC-0${i}`, manufacturer: 'Dell', model: 'OptiPlex 7010', os: 'Windows 11 Pro', serial_number: `DLCBS${i}0` });
rel(app, nas, 'corre_em');

// Gabinete
ci('GCC', gcc, 'Portátil', 'GCC-NB-01', { manufacturer: 'Apple', model: 'MacBook Air M3', os: 'macOS 15', serial_number: 'C02GCC001' });
ci('GCC', gcc, 'Portátil', 'GCC-NB-02', { manufacturer: 'Apple', model: 'MacBook Air M3', os: 'macOS 15', serial_number: 'C02GCC002', status: 'em_stock' });
ci('GCC', null, 'Recurso cloud', 'Google Workspace', { attributes: { fornecedor: 'Google', subscricao: 'gcc.example' } });

// Contratos
function contract(c, d, ciIds = []) {
  const row = { client_id: clients[c], ...d };
  const cols = Object.keys(row);
  const id = ins(`INSERT INTO contracts (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...Object.values(row));
  for (const ciId of ciIds) ins('INSERT INTO contract_cis (contract_id, ci_id) VALUES (?, ?)', id, ciId);
  return id;
}
contract('ACME', { name: 'FortiCare 24x7 + UTP', kind: 'suporte', vendor: 'Fortinet', reference: 'FC-2024-7781', start_date: day(-320), end_date: day(45), notice_days: 30, cost: 1180, billing: 'anual' }, [fw]);
contract('ACME', { name: 'Microsoft 365 Business Premium', kind: 'subscricao', vendor: 'Microsoft (via CSP)', quantity: 45, start_date: day(-295), end_date: day(70), auto_renew: 1, cost: 990, billing: 'mensal' });
contract('ACME', { name: 'ProSupport Dell PowerEdge', kind: 'garantia', vendor: 'Dell', reference: 'SVC-DL7XK92', start_date: '2021-03-15', end_date: day(-10), cost: 2400, billing: 'unico' }, [hv]);
contract('ACME', { name: 'Manutenção ERP Primavera', kind: 'manutencao', vendor: 'Primavera BSS', start_date: day(-200), end_date: day(165), notice_days: 60, cost: 310, billing: 'mensal', owner: 'Direção Financeira' }, [erp]);
contract('CBS', { name: 'Licença Software Clínico', kind: 'licenca', vendor: 'MedSoft', quantity: 12, start_date: day(-100), end_date: day(265), cost: 4200, billing: 'anual' }, [app]);
contract('GCC', { name: 'Google Workspace Business Standard', kind: 'subscricao', vendor: 'Google', quantity: 6, auto_renew: 1, start_date: day(-400), end_date: day(330), cost: 69, billing: 'mensal' });

// Incidente de exemplo (vindo de uma ferramenta de helpdesk)
const tk = ins(`INSERT INTO tickets (client_id, system, external_id, title, status, priority, url)
  VALUES (?, 'GLPI', '4711', 'ERP muito lento ao faturar', 'Em curso', 'Alta', 'https://glpi.example/front/ticket.form.php?id=4711')`, clients.ACME);
ins('INSERT INTO ticket_cis (ticket_id, ci_id) VALUES (?, ?), (?, ?)', tk, erp, tk, vmDb);

// Utilizadores de demonstração
const pw = (p) => hashPassword(p);
if (!db.prepare("SELECT 1 FROM users WHERE username = 'admin'").get()) {
  ins("INSERT INTO users (username, name, password_hash, role, org_id, is_platform) VALUES ('admin', 'Administrador', ?, 'admin', ?, 1)", pw('admin123'), ORG);
}
const tech = ins("INSERT INTO users (username, name, password_hash, role, org_id) VALUES ('tecnico', 'Técnico Norte', ?, 'tech', ?)", pw('tecnico-demo'), ORG);
ins('INSERT INTO user_clients (user_id, client_id) VALUES (?,?), (?,?)', tech, clients.ACME, tech, clients.CBS);
ins("INSERT INTO users (username, name, password_hash, role, client_id, org_id) VALUES ('cliente.acme', 'Rita Fonseca (Acme)', ?, 'client', ?, ?)", pw('cliente-demo'), clients.ACME, ORG);
db.prepare("INSERT INTO audit (entity, actor, action, label) VALUES ('system', 'seed', 'create', 'Dados de demonstração')").run();
db.exec('COMMIT');

console.log(`Dados de demonstração criados em ${DB_FILE}`);
console.log('  admin        / admin123       (administrador; se o admin já existia, mantém a password)');
console.log('  tecnico      / tecnico-demo   (técnico com acesso a ACME e CBS)');
console.log('  cliente.acme / cliente-demo   (cliente, só leitura, apenas ACME)');
