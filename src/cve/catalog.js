'use strict';
/*
 * Catálogo: nome do software instalado (como aparece no Windows) → produto CPE da NVD (fornecedor:produto).
 * Curado à mão: só entram produtos cujo nome no Windows e cujo CPE são inequívocos.
 * Para acrescentar um produto, confirme o CPE em https://nvd.nist.gov/products/cpe/search.
 */
/** @type {Array<[RegExp, string]>} */
const CATALOG = [
  [/^Google Chrome$/i, 'google:chrome'],
  [/^Mozilla Firefox(?! ESR)\b/i, 'mozilla:firefox'],
  [/^Mozilla Firefox ESR\b/i, 'mozilla:firefox_esr'],
  [/^Mozilla Thunderbird\b/i, 'mozilla:thunderbird'],
  [/^Microsoft Edge$/i, 'microsoft:edge_chromium'],
  [/^7-Zip\b/i, '7-zip:7-zip'],
  [/^WinRAR\b/i, 'rarlab:winrar'],
  [/^Notepad\+\+/i, 'notepad-plus-plus:notepad\\+\\+'],
  [/^VLC media player$/i, 'videolan:vlc_media_player'],
  [/^PuTTY\b/i, 'putty:putty'],
  [/^WinSCP\b/i, 'winscp:winscp'],
  [/^FileZilla(?: Client)?\b/i, 'filezilla-project:filezilla_client'],
  [/^Wireshark\b/i, 'wireshark:wireshark'],
  [/^KeePass Password Safe\b/i, 'keepass:keepass'],
  [/^TeamViewer\b/i, 'teamviewer:teamviewer'],
  [/^AnyDesk$/i, 'anydesk:anydesk'],
  [/^Git$|^Git version /i, 'git-scm:git'],
  [/^Python 3\.\d+\.\d+/i, 'python:python'],
  [/^Node\.js$/i, 'nodejs:node.js'],
  [/^LibreOffice\b/i, 'libreoffice:libreoffice'],
  [/^GIMP\b/i, 'gimp:gimp'],
  [/^Foxit PDF Reader$/i, 'foxit:pdf_reader'],
  [/^Adobe Acrobat Reader(?: DC)?\b/i, 'adobe:acrobat_reader_dc'],
  [/^VMware Workstation\b/i, 'vmware:workstation'],
  [/^VMware Tools$/i, 'vmware:tools'],
  [/^Citrix Workspace\b/i, 'citrix:workspace'],
  [/^PostgreSQL \d+/i, 'postgresql:postgresql'],
  [/^OpenVPN \d/i, 'openvpn:openvpn'],
];

/** Produto CPE para um nome de software, ou null. */
function productFor(name) {
  const n = String(name || '').trim();
  for (const [re, product] of CATALOG) if (re.test(n)) return product;
  return null;
}

/* ------------------------------------------------------------------ versões */
const parts = (v) => String(v).toLowerCase().split(/[.\-_+ ]+/).filter(Boolean)
  .map((p) => (/^\d+$/.test(p) ? Number(p) : p));
/** Compara versões ("23.01" < "24.07", "1.10" > "1.9"). Negativo, 0 ou positivo. */
function compareVersions(a, b) {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? 0;
    const q = y[i] ?? 0;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p - q;
    return String(p) < String(q) ? -1 : 1;
  }
  return 0;
}

/** Parte numérica da versão instalada ("ad 9.6.11" → "9.6.11", "2.43.0.windows.1" → "2.43.0"). */
function cleanVersion(v) {
  const m = /\d+(?:[._-]\d+)*/.exec(String(v || ''));
  return m ? m[0] : '';
}

/** A versão está dentro do intervalo de um critério da NVD? r = { v, si, se, ei, ee } */
function inRange(raw, r) {
  const version = cleanVersion(raw);
  if (!version) return false;
  if (r.v && r.v !== '*' && r.v !== '-') return compareVersions(version, r.v) === 0;
  if (!r.si && !r.se && !r.ei && !r.ee) return false; // sem versões: não se atribui a nenhuma (evita falsos alarmes)
  if (r.si && compareVersions(version, r.si) < 0) return false;
  if (r.se && compareVersions(version, r.se) <= 0) return false;
  if (r.ei && compareVersions(version, r.ei) > 0) return false;
  if (r.ee && compareVersions(version, r.ee) >= 0) return false;
  return true;
}

module.exports = { CATALOG, productFor, compareVersions, inRange, cleanVersion };
