# Rizoma (CMDB multi-cliente) — imagem de produção (sem dependências npm)
FROM node:24-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    CMDB_DB=/data/cmdb.db

WORKDIR /app
COPY package.json server.js ./
COPY src ./src
COPY public ./public
COPY agent ./agent
COPY scripts ./scripts

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
