'use strict';
/* Conector Microsoft (por cliente): licenças M365, dispositivos Intune e recursos Azure.
   Usa uma App Registration no tenant do cliente com "client credentials":
     Graph (permissões de aplicação): Organization.Read.All, DeviceManagementManagedDevices.Read.All
     Azure: função "Reader" nas subscrições a inventariar. */

const GRAPH = 'https://graph.microsoft.com';
const ARM = 'https://management.azure.com';

// Nomes comerciais dos SKUs mais comuns (os restantes ficam com o código do SKU)
const SKU_NAMES = {
  O365_BUSINESS_ESSENTIALS: 'Microsoft 365 Business Basic',
  O365_BUSINESS_PREMIUM: 'Microsoft 365 Business Standard',
  SPB: 'Microsoft 365 Business Premium',
  O365_BUSINESS: 'Microsoft 365 Apps for business',
  OFFICESUBSCRIPTION: 'Microsoft 365 Apps for enterprise',
  STANDARDPACK: 'Office 365 E1',
  ENTERPRISEPACK: 'Office 365 E3',
  ENTERPRISEPREMIUM: 'Office 365 E5',
  SPE_E3: 'Microsoft 365 E3',
  SPE_E5: 'Microsoft 365 E5',
  SPE_F1: 'Microsoft 365 F3',
  EXCHANGESTANDARD: 'Exchange Online (Plan 1)',
  EXCHANGEENTERPRISE: 'Exchange Online (Plan 2)',
  EMS: 'Enterprise Mobility + Security E3',
  EMSPREMIUM: 'Enterprise Mobility + Security E5',
  INTUNE_A: 'Microsoft Intune Plan 1',
  AAD_PREMIUM: 'Microsoft Entra ID P1',
  AAD_PREMIUM_P2: 'Microsoft Entra ID P2',
  POWER_BI_PRO: 'Power BI Pro',
  PROJECTPROFESSIONAL: 'Project Plan 3',
  VISIOCLIENT: 'Visio Plan 2',
  Microsoft_Teams_Exploratory_Dept: 'Microsoft Teams Exploratory',
  Microsoft_365_Copilot: 'Microsoft 365 Copilot',
};

// Tipos Azure sem interesse como CI (ruído)
const AZURE_SKIP = [
  'microsoft.compute/disks', 'microsoft.compute/snapshots', 'microsoft.compute/virtualmachines/extensions',
  'microsoft.compute/restorepointcollections', 'microsoft.network/networkinterfaces', 'microsoft.network/networksecuritygroups',
  'microsoft.network/publicipaddresses', 'microsoft.network/networkwatchers', 'microsoft.insights/', 'microsoft.alertsmanagement/',
  'microsoft.operationsmanagement/', 'microsoft.portal/dashboards', 'microsoft.network/privatednszones/virtualnetworklinks',
  'microsoft.devtestlab/schedules', 'microsoft.managedidentity/', 'microsoft.security/',
];
function azureType(t) {
  const x = t.toLowerCase();
  if (x === 'microsoft.compute/virtualmachines') return 'Máquina virtual';
  if (/^microsoft\.(sql\/servers\/databases|dbforpostgresql|dbformysql|dbformariadb|documentdb|cache\/redis)/.test(x)) return 'Base de dados';
  if (/^microsoft\.web\/(sites|staticsites)/.test(x)) return 'Aplicação';
  if (/^microsoft\.network\/(azurefirewalls|applicationgateways)/.test(x)) return 'Firewall';
  return 'Recurso cloud';
}

async function errorText(r) {
  try {
    const j = await r.json();
    return (j.error && (j.error.message || j.error_description || j.error.code)) || j.error_description || JSON.stringify(j).slice(0, 200);
  } catch { return r.statusText; }
}

async function getToken(fetchFn, tenant, appId, secret, scope) {
  const r = await fetchFn(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: appId, client_secret: secret, scope, grant_type: 'client_credentials' }).toString(),
  });
  if (!r.ok) throw new Error(`autenticação falhou (${r.status}): ${await errorText(r)}`);
  return (await r.json()).access_token;
}

async function getAll(fetchFn, url, token) {
  const items = [];
  let next = url;
  for (let page = 0; next && page < 200; page++) {
    const r = await fetchFn(next, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`${r.status} em ${new URL(next).pathname}: ${await errorText(r)}`);
    const j = await r.json();
    items.push(...(j.value || []));
    next = j['@odata.nextLink'] || j.nextLink || null;
  }
  return items;
}

const gb = (bytes) => (bytes ? Math.round(Number(bytes) / 1024 ** 3) : null);

/**
 * Sincroniza um cliente. Devolve um relatório por categoria; uma categoria que falha não impede as outras
 * e só abate ativos de categorias lidas com sucesso.
 */
async function syncMicrosoft({ clientId, tenantId, appId, secret, options, fetchFn, reconciler, tx }) {
  const report = { licencas: null, dispositivos: null, azure: null, erros: [] };
  const empty = () => ({ created: 0, updated: 0, unchanged: 0, retired: 0 });
  const count = (c, res) => { c[res.action]++; };

  let graphToken = null;
  if (options.licenses || options.intune) {
    try { graphToken = await getToken(fetchFn, tenantId, appId, secret, `${GRAPH}/.default`); } catch (e) { report.erros.push(`Microsoft Graph: ${e.message}`); }
  }

  if (options.licenses && graphToken) {
    try {
      const skus = await getAll(fetchFn, `${GRAPH}/v1.0/subscribedSkus`, graphToken);
      const c = empty();
      tx(() => {
        const seen = [];
        for (const k of skus) {
          const ext = `m365-sku:${k.skuId}`;
          seen.push(ext);
          const status = k.capabilityStatus === 'Enabled' ? 'em_producao' : k.capabilityStatus === 'Warning' ? 'em_manutencao' : 'abatido';
          count(c, reconciler.upsert(clientId, {
            external_id: ext, name: SKU_NAMES[k.skuPartNumber] || k.skuPartNumber, type: 'Licença',
            attributes: {
              fornecedor: 'Microsoft', sku: k.skuPartNumber, quantidade: k.prepaidUnits ? k.prepaidUnits.enabled : null,
              em_uso: k.consumedUnits, estado_microsoft: k.capabilityStatus,
            },
          }, 'm365', 'm365', { owns: true, status }));
        }
        c.retired = reconciler.retireMissing(clientId, 'm365-sku:', seen, 'm365');
      });
      report.licencas = c;
    } catch (e) { report.erros.push(`Licenças M365: ${e.message}`); }
  }

  if (options.intune && graphToken) {
    try {
      const devices = await getAll(fetchFn, `${GRAPH}/v1.0/deviceManagement/managedDevices`, graphToken);
      const c = empty();
      tx(() => {
        const seen = [];
        for (const d of devices) {
          const ext = `intune:${d.id}`;
          seen.push(ext);
          const os = String(d.operatingSystem || '');
          let type = 'Posto de trabalho';
          if (/^(ios|ipados|android)/i.test(os)) type = 'Telemóvel';
          else if (d.chassisType === 'laptop' || /book/i.test(d.model || '')) type = 'Portátil';
          else if (d.chassisType === 'enterpriseServer') type = 'Servidor';
          count(c, reconciler.upsert(clientId, {
            external_id: ext, name: d.deviceName, hostname: d.deviceName, serial_number: d.serialNumber,
            manufacturer: d.manufacturer, model: d.model, os: [os, d.osVersion].filter(Boolean).join(' '), type,
            attributes: {
              utilizador: d.userPrincipalName, conformidade: d.complianceState,
              armazenamento_gb: gb(d.totalStorageSpaceInBytes), gestao: 'Intune',
            },
          }, 'intune', 'intune', { owns: true, lastSeen: d.lastSyncDateTime }));
        }
        c.retired = reconciler.retireMissing(clientId, 'intune:', seen, 'intune');
      });
      report.dispositivos = c;
    } catch (e) { report.erros.push(`Dispositivos Intune: ${e.message}`); }
  }

  if (options.azure) {
    try {
      const token = await getToken(fetchFn, tenantId, appId, secret, `${ARM}/.default`);
      const subs = await getAll(fetchFn, `${ARM}/subscriptions?api-version=2022-12-01`, token);
      const bySub = [];
      for (const s of subs) bySub.push([s, await getAll(fetchFn, `${ARM}${s.id}/resources?api-version=2021-04-01`, token)]);
      const c = empty();
      tx(() => {
        const seen = [];
        for (const [s, resources] of bySub) {
          const subExt = `azure:${s.id.toLowerCase()}`;
          seen.push(subExt);
          const subRes = reconciler.upsert(clientId, {
            external_id: subExt, name: `Subscrição Azure: ${s.displayName}`, type: 'Recurso cloud',
            attributes: { fornecedor: 'Azure', subscricao: s.subscriptionId, estado_azure: s.state },
          }, 'azure', 'azure', { owns: true, status: s.state === 'Enabled' ? 'em_producao' : 'abatido' });
          count(c, subRes);
          for (const r of resources) {
            if (AZURE_SKIP.some((p) => r.type.toLowerCase().startsWith(p))) continue;
            const ext = `azure:${r.id.toLowerCase()}`;
            seen.push(ext);
            const rg = (/\/resourcegroups\/([^/]+)/i.exec(r.id) || [])[1];
            const res = reconciler.upsert(clientId, {
              external_id: ext, name: r.name, type: azureType(r.type),
              hostname: r.type.toLowerCase() === 'microsoft.compute/virtualmachines' ? r.name : null,
              attributes: {
                fornecedor: 'Azure', tipo_azure: r.type, regiao: r.location, grupo_recursos: rg,
                sku: r.sku && (r.sku.name || r.sku.tier), subscricao: s.displayName,
                tags: r.tags ? Object.entries(r.tags).map(([k, v]) => `${k}=${v}`).join(', ') : null,
              },
            }, 'azure', 'azure', { owns: true });
            count(c, res);
            reconciler.relate(res.id, subRes.id, 'alojado_em');
          }
        }
        c.retired = reconciler.retireMissing(clientId, 'azure:', seen, 'azure');
      });
      report.azure = c;
    } catch (e) { report.erros.push(`Azure: ${e.message}`); }
  }
  return report;
}

module.exports = { syncMicrosoft, SKU_NAMES };
