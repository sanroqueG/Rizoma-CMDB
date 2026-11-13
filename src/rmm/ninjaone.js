'use strict';
/*
 * Cliente da API pública do NinjaOne (v2), com OAuth2 "client credentials" (âmbito "monitoring", só leitura).
 * Criar a aplicação no NinjaOne: Administração → Apps → API → Client app IDs → "API Services (machine-to-machine)",
 * com o âmbito Monitoring e o tipo de concessão Client Credentials.
 *
 * Os campos dos dispositivos seguem a documentação pública da API (GET /v2/devices-detailed).
 * Campos em falta não fazem falhar a sincronização: ficam vazios.
 */
const REGIONS = {
  eu: 'eu.ninjarmm.com', us: 'app.ninjarmm.com', us2: 'us2.ninjarmm.com', ca: 'ca.ninjarmm.com', oc: 'oc.ninjarmm.com',
};
const PAGE = 1000;

/** Tipo de ativo do Rizoma (tipos base) a partir do nodeClass do NinjaOne. */
function typeFromNodeClass(nodeClass, device = {}) {
  const c = String(nodeClass || '').toUpperCase();
  if (/_SERVER$|^LINUX_SERVER$/.test(c) || c === 'WINDOWS_SERVER') return 'Servidor';
  if (/VM_GUEST|_VM$|HYPERV_VMM_GUEST|VMWARE_VM_GUEST/.test(c)) return 'Máquina virtual';
  if (/VM_HOST|HYPERV|VMWARE_VM_HOST|CLOUD_MONITOR_TARGET/.test(c)) return 'Servidor';
  if (/^NMS_(SWITCH|ROUTER|WAP|NETWORK|APPLIANCE|COMPUTER|OTHER)/.test(c)) return 'Equipamento de rede';
  if (/^NMS_FIREWALL/.test(c)) return 'Firewall';
  if (/^NMS_PRINTER/.test(c)) return 'Impressora';
  if (/^MDM_/.test(c) || /ANDROID|APPLE_IOS|APPLE_IPADOS/.test(c)) return 'Telemóvel';
  const chassis = String(device.system?.chassisType || device.chassisType || '').toLowerCase();
  if (/laptop|notebook|portable/.test(chassis)) return 'Portátil';
  return 'Posto de trabalho';
}

function createNinjaOne({ region, clientId, secret, fetchFn = globalThis.fetch }) {
  const host = REGIONS[region];
  if (!host) throw new Error(`Região NinjaOne desconhecida: ${region}`);
  const base = `https://${host}`;
  let token = null;
  let tokenExp = 0;

  async function getToken() {
    if (token && Date.now() < tokenExp - 60e3) return token;
    const r = await fetchFn(`${base}/ws/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret, scope: 'monitoring' }).toString(),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.access_token) {
      throw new Error(`O NinjaOne recusou as credenciais (${r.status}${data.error_description || data.error ? `: ${data.error_description || data.error}` : ''})`);
    }
    token = data.access_token;
    tokenExp = Date.now() + (Number(data.expires_in) || 3600) * 1000;
    return token;
  }

  async function get(path) {
    const r = await fetchFn(`${base}${path}`, { headers: { Authorization: `Bearer ${await getToken()}`, Accept: 'application/json' } });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`NinjaOne ${path.split('?')[0]}: ${r.status}${t ? ` ${t.slice(0, 200)}` : ''}`);
    }
    return r.json();
  }

  /** Páginas por cursor (after = último id da página anterior). */
  async function paged(path) {
    const out = [];
    let after = 0;
    for (let i = 0; i < 1000; i++) {
      const page = await get(`${path}${path.includes('?') ? '&' : '?'}pageSize=${PAGE}${after ? `&after=${after}` : ''}`);
      if (!Array.isArray(page) || !page.length) break;
      out.push(...page);
      if (page.length < PAGE) break;
      after = page[page.length - 1].id;
    }
    return out;
  }

  return {
    host,
    organizations: () => paged('/v2/organizations'),
    devices: () => paged('/v2/devices-detailed'),
  };
}

/** Ativo do Rizoma a partir de um dispositivo do NinjaOne. */
function deviceToAsset(d) {
  const sys = d.system || {};
  const os = d.os || {};
  const ram = d.memory?.capacity;
  const ips = (d.ipAddresses || []).filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip) && !ip.startsWith('169.254.'));
  const cpu = (d.processors || [])[0];
  return {
    external_id: `ninjaone:${d.id}`,
    name: d.displayName || d.systemName || d.dnsName,
    hostname: d.systemName || d.dnsName || null,
    ip_address: ips[0] || null,
    serial_number: sys.serialNumber || sys.biosSerialNumber || null,
    manufacturer: sys.manufacturer || null,
    model: sys.model || null,
    os: os.name || null,
    type: typeFromNodeClass(d.nodeClass, d),
    attributes: {
      gestao: 'NinjaOne',
      ninjaone_id: d.id,
      ninjaone_classe: d.nodeClass || null,
      cpu: cpu ? cpu.name : null,
      ram_gb: ram ? Math.round(ram / 1024 ** 3) : null,
      utilizador: d.lastLoggedInUser || null,
      online: d.offline === undefined ? null : !d.offline,
      dominio: sys.domain || null,
    },
    lastSeen: d.lastContact ? new Date(Number(d.lastContact) * 1000).toISOString() : null,
  };
}

module.exports = { createNinjaOne, deviceToAsset, typeFromNodeClass, REGIONS };
