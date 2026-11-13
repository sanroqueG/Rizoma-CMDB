'use strict';
/*
 * Documentação da API pública (OpenAPI 3.1), gerada a partir das próprias rotas: as marcadas com { api: true }
 * e os esquemas declarados em { body }. Disponível em GET /api/v1/openapi.json (sem autenticação).
 */
const { toJsonSchema } = require('../schema');
const { version } = require('../../package.json');

module.exports = function registerApiDocs(core) {
  const { add, routes, opts } = core;

  function spec() {
    const paths = {};
    for (const r of routes.filter((x) => x.flags.api && !x.flags.internal)) {
      const p = `/api/v1/${r.pattern.slice(5)}`.replace(/:(\w+)/g, '{$1}');
      const f = r.flags;
      const op = {
        summary: f.summary,
        ...(f.description && { description: f.description }),
        tags: [f.tag || 'Integração'],
        security: [{ token: [] }],
        ...(f.scope && { 'x-rizoma-scope': f.scope }),
        parameters: Object.entries(f.query || {}).map(([name, description]) => ({ name, in: 'query', required: true, description, schema: { type: 'string' } })),
        ...(f.body && { requestBody: { required: true, content: { 'application/json': { schema: toJsonSchema(f.body) } } } }),
        responses: {
          200: { description: 'Sucesso' },
          400: { description: 'Pedido inválido: { "error": "mensagem" }' },
          401: { description: 'Token em falta ou inválido' },
          403: { description: 'O token não tem a permissão necessária, ou a organização está suspensa' },
        },
      };
      paths[p] = { ...(paths[p] || {}), [r.method.toLowerCase()]: op };
    }
    const base = String(opts.publicUrl ?? process.env.CMDB_PUBLIC_URL ?? '').replace(/\/+$/, '');
    return {
      openapi: '3.1.0',
      info: {
        title: 'Rizoma API',
        version,
        description: 'API de integração do Rizoma: inventário automático (agentes) e helpdesk (tickets). '
          + 'Autenticação com um token do cliente (Clientes → cliente → Tokens), no cabeçalho Authorization: Bearer <token>. '
          + 'Cada token tem permissões: "ingest" (inventário) e/ou "tickets". Os caminhos sem /v1 continuam a funcionar, mas estão obsoletos.',
      },
      ...(base && { servers: [{ url: base }] }),
      components: { securitySchemes: { token: { type: 'http', scheme: 'bearer', description: 'Token do cliente (cmdb_…)' } } },
      paths,
    };
  }

  add('GET', '/api/openapi.json', () => spec(), { public: true, api: true, internal: true });
};
