'use strict';
/* Relatórios por cliente: dados para o relatório imprimível (PDF via browser) e exportação Excel (.xlsx).
   O Excel é gerado numa worker thread (ver src/jobs.js) para não bloquear os outros pedidos. */
const { collectReport } = require('../reports-data');

module.exports = function registerReports(core) {
  const { add, getClient, store, runJob, SECURITY_HEADERS } = core;

  add('GET', '/api/clients/:id/report', ({ user, params }) => {
    const r = collectReport(store, getClient(user, params.id));
    // O relatório imprimível não precisa da lista completa de relações
    return { ...r, relationships: undefined, relationship_count: r.relationships.length };
  });

  add('GET', '/api/clients/:id/report.xlsx', async ({ user, params, res, ctx }) => {
    const c = getClient(user, params.id);
    const buf = Buffer.from(await runJob('report-xlsx', { clientId: c.id }));
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="relatorio-${c.code}-${new Date().toISOString().slice(0, 10)}.xlsx"`,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
    ctx.raw = true;
  });
};
