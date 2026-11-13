'use strict';
/* Leitura de ficheiros tabulares no browser: CSV (UTF-8 ou Windows-1252, ; , ou tab) e XLSX (Excel).
   O XLSX é um ZIP com XML: é descomprimido com DecompressionStream, sem bibliotecas externas. */
(function () {
  function decodeText(buf) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
  }

  function parseCsv(text) {
    text = text.replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/, 1)[0];
    const delim = [';', ',', '\t'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
        } else field += c;
      } else if (c === '"' && field === '') quoted = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
  }

  async function unzip(buf, wanted) {
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Ficheiro XLSX inválido ou corrompido');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const out = {};
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Ficheiro XLSX inválido');
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (!wanted(name)) continue;
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const raw = new Uint8Array(buf, start, csize);
      let bytes;
      if (method === 0) bytes = raw;
      else if (method === 8) {
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      } else throw new Error(`Compressão ZIP não suportada (${method})`);
      out[name] = new TextDecoder().decode(bytes);
    }
    return out;
  }

  const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
  const colIndex = (ref) => {
    const letters = /^[A-Z]+/.exec(ref)[0];
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  const textOf = (el) => [...el.getElementsByTagName('t')].filter((t) => t.parentNode.nodeName !== 'rPh').map((t) => t.textContent).join('');

  async function parseXlsx(buf) {
    const files = await unzip(buf, (n) => n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels'
      || n === 'xl/sharedStrings.xml' || n.startsWith('xl/worksheets/sheet'));
    if (!files['xl/workbook.xml']) throw new Error('Não parece um ficheiro Excel (.xlsx)');
    // primeira folha do livro
    const wb = xml(files['xl/workbook.xml']);
    const sheet = wb.getElementsByTagName('sheet')[0];
    const rid = sheet && (sheet.getAttribute('r:id') || sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
    let target = 'xl/worksheets/sheet1.xml';
    if (rid && files['xl/_rels/workbook.xml.rels']) {
      const rel = [...xml(files['xl/_rels/workbook.xml.rels']).getElementsByTagName('Relationship')].find((r) => r.getAttribute('Id') === rid);
      if (rel) {
        const t = rel.getAttribute('Target');
        target = t.startsWith('/') ? t.slice(1) : `xl/${t}`;
      }
    }
    const shared = files['xl/sharedStrings.xml'] ? [...xml(files['xl/sharedStrings.xml']).getElementsByTagName('si')].map(textOf) : [];
    const sheetXml = files[target];
    if (!sheetXml) throw new Error('Folha de cálculo não encontrada no ficheiro');
    const rows = [];
    for (const r of xml(sheetXml).getElementsByTagName('row')) {
      const rowIdx = Number(r.getAttribute('r')) - 1;
      const arr = [];
      for (const c of r.getElementsByTagName('c')) {
        const ref = c.getAttribute('r');
        const ci = ref ? colIndex(ref) : arr.length;
        const t = c.getAttribute('t');
        const v = c.getElementsByTagName('v')[0];
        let val = '';
        if (t === 's') val = v ? shared[Number(v.textContent)] ?? '' : '';
        else if (t === 'inlineStr') val = textOf(c);
        else if (t === 'b') val = v && v.textContent === '1' ? 'TRUE' : 'FALSE';
        else val = v ? v.textContent : '';
        arr[ci] = val;
      }
      rows[Number.isNaN(rowIdx) ? rows.length : rowIdx] = Array.from(arr, (x) => x ?? '');
    }
    return rows.filter((r) => r && r.some((v) => String(v).trim() !== ''));
  }

  /** Lê um File (CSV/XLSX) e devolve { headers, rows: [{cabeçalho: valor}] }. */
  async function readTable(file) {
    const buf = await file.arrayBuffer();
    const isZip = buf.byteLength > 4 && new DataView(buf).getUint32(0, true) === 0x04034b50;
    const matrix = isZip ? await parseXlsx(buf) : parseCsv(decodeText(buf));
    if (matrix.length < 2) throw new Error('O ficheiro não tem linhas de dados (a 1.ª linha deve ser o cabeçalho)');
    const headers = matrix[0].map((h, i) => String(h).trim() || `Coluna ${i + 1}`);
    const rows = matrix.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] === undefined ? '' : String(r[i])])));
    return { headers, rows };
  }

  window.FileTables = { readTable, parseCsv, parseXlsx };
}());
