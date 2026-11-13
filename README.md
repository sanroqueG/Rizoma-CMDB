# Rizoma

CMDB multi-cliente para prestadores de serviços de TI que gerem os ativos de **vários clientes**, em
modo **SaaS**: cada prestador de serviços tem a sua **organização**, com os seus utilizadores e clientes, isolada das outras.
Inclui:
- inventário de ativos, com relações entre eles, mapa visual e análise de impacto;
- inventário automático por agentes (Windows, Linux, macOS) e por Microsoft 365 / Intune / Azure;
- importação de CSV e Excel;
- login com SSO (OIDC) e autenticação de dois fatores;
- auditoria completa.

Os dados de cada organização, e de cada cliente dentro dela, ficam isolados.

**Sem dependências externas:** precisa apenas de Node.js ≥ 22.13, que já inclui o SQLite, ou de Docker.
Não há `npm install` nem passo de build.

**Interface:** construída com o [Tabler](https://tabler.io) 1.4.0 (MIT), com [Tabler Icons](https://tabler.io/icons) 3.34.0 (MIT)
e o tipo de letra [Inter](https://rsms.me/inter/) (OFL). Os ficheiros estão em `public/vendor/`, com as respetivas licenças,
e não dependem de nenhum CDN. A cor da marca, o tipo de letra e os poucos estilos próprios estão em `public/app.css`.
O manual de marca, o logótipo e o sistema de design estão em `brand/`.

## Arranque rápido

```bash
npm run demo     # cria dados de exemplo e arranca em http://127.0.0.1:3000
npm start        # BD vazia; login inicial admin / admin123 (obriga a mudar a password)
npm test         # testes automáticos (API, isolamento entre organizações, workers, multi-instância, SSO, 2FA, browser…)
npm run typecheck   # verificação de tipos (JSDoc + TypeScript, só para desenvolvimento)
```

Com Docker:

```bash
cp .env.example .env        # ajustar
docker compose up -d
# login inicial: admin / admin123
```

Utilizadores de demonstração (`npm run demo`):

| Utilizador | Password | Perfil |
|---|---|---|
| `admin` | `admin123` | Administrador da organização e da plataforma |
| `tecnico` | `tecnico-demo` | Técnico com acesso à ACME e à CBS |
| `cliente.acme` | `cliente-demo` | Cliente ACME, só leitura |

## SaaS: organizações

```
Plataforma (administradores da plataforma)
└── Organização = um prestador de serviços de TI (plano, limites, estado)
    ├── Utilizadores: administrador · técnico (clientes atribuídos) · cliente (só leitura)
    └── Clientes → locais, ativos, relações, contratos, tickets, tokens, conector M365
```

- **Isolamento:** todas as consultas passam por `src/access.js`. Um recurso de outra organização devolve `404`.
  O teste `test/isolation.test.js` percorre **todas** as rotas, incluindo as futuras, com o administrador de outra
  organização, e falha se alguma devolver ou alterar dados que não são dela.
- **Registo self-service** (`CMDB_SIGNUP=1`): no ecrã de login aparece "Criar conta para a sua empresa", que cria a
  organização e o seu primeiro administrador.
- **Plataforma** (menu Administração → Plataforma, só para administradores da plataforma): criar organizações,
  alterar plano e limites (clientes, ativos, utilizadores), suspender (termina as sessões de imediato), eliminar.
- **Limites do plano:** ao chegar ao limite, a criação devolve `402` com a explicação. Limites por omissão para novas
  organizações em `CMDB_PLAN_MAX_CLIENTS`, `CMDB_PLAN_MAX_CIS` e `CMDB_PLAN_MAX_USERS`.
- **Organização** (menu Administração → Organização): utilização do plano e **exportação de todos os dados** em JSON
  (portabilidade, RGPD art.º 20.º), sem passwords nem segredos.
- **Instalações anteriores:** a migração 2 coloca tudo na "Organização principal", e o primeiro administrador fica
  administrador da plataforma.

## Funcionalidades

### Gestão de ativos
- **Multi-cliente:** cada ativo, local, token e conector pertence a um cliente. Todas as consultas são filtradas pelo âmbito
  do utilizador. Um ativo de outro cliente devolve `404`, para não revelar que existe.
- **Perfis:**
  - *Administrador* tem acesso a tudo.
  - *Técnico* lê e escreve apenas nos clientes que lhe foram atribuídos.
  - *Cliente* só pode ler, e apenas o seu próprio cliente.
- **Ativos (CIs):** 13 tipos predefinidos, com atributos próprios de cada tipo e atributos livres. Cada ativo tem estado,
  criticidade, ambiente, garantia e responsável.
- **Relações e impacto:** *depende de*, *corre em*, *alojado em*, *ligado a*, *usa*.
  - A análise de impacto mostra, para cada ativo, o que é afetado se ele falhar e de que ativos ele depende.
  - **Mapa de relações** em SVG, para um ativo (1 a 4 níveis) ou para o cliente inteiro, com camadas de serviço → aplicação → infraestrutura.
- **Dashboard:** garantias a expirar, contratos a renovar, agentes sem contacto há mais de 30 dias e atividade recente.
- **Contratos:** licenças de software, suporte, manutenção, subscrições, outsourcing… por cliente, com fornecedor, datas,
  pré-aviso de denúncia, renovação automática, custo e periodicidade (custo anual calculado) e ligação aos ativos abrangidos.
  As renovações aparecem no dashboard e no resumo semanal.
- **Relatórios por cliente:** página imprimível (Imprimir → Guardar como PDF) e exportação Excel (.xlsx) com resumo,
  inventário, contratos, garantias/renovações e relações.
- **Tickets e incidentes:** ligue tickets de GLPI, Jira, Freshservice, Zendesk… aos ativos, à mão ou automaticamente
  por webhook (ver [Integração com tickets](#integração-com-tickets)).
- **Pesquisa global (Ctrl K):** ativos (nome, hostname, nº de série, IP, etiqueta, modelo, SO, notas), clientes, locais,
  contratos e tickets de todos os clientes a que o utilizador tem acesso.
- **Auditoria:** cada alteração fica registada com o valor anterior e o novo.

### Entrada de dados
- **Importação de CSV e Excel (.xlsx):**
  - Simulação antes de gravar.
  - Aceita colunas em português ou inglês e o próprio CSV exportado pela CMDB. Ficheiros vindos do Excel em português (Windows-1252 e `;`) também funcionam.
  - Datas em `DD/MM/AAAA`, em `AAAA-MM-DD` ou no formato de data do Excel.
  - Pode criar os locais que faltem e atualizar ativos existentes, encontrados pelo nº de série, hostname ou nome.
  - Disponibiliza um modelo CSV para descarregar.
- **Agentes de inventário:**
  - [Windows (PowerShell)](agent/inventario.ps1) e [Linux/macOS (sh)](agent/inventario.sh).
  - O servidor disponibiliza-os em `/agent/…`.
  - A reconciliação procura o ativo por `external_id`, depois por nº de série e depois por hostname, para não criar duplicados.
- **Conector Microsoft 365 / Azure**, configurado por cliente, com sincronização diária automática:
  - **Licenças M365:** quantidade comprada e em uso, com nomes comerciais.
  - **Dispositivos Intune:** utilizador, conformidade e último contacto. Funde com os ativos já inventariados pelo agente.
  - **Recursos Azure:** VMs, bases de dados, aplicações web, etc., cada um ligado à respetiva subscrição. Recursos sem interesse, como discos e NICs, são ignorados.
  - Ativos que desaparecem da origem passam a "abatido", sem perder o histórico.

### Segurança
- **SSO (OpenID Connect):** Microsoft Entra ID, Google Workspace, Keycloak, Authentik, Okta…
  - Usa Authorization Code com PKCE e valida a assinatura, o emissor, a audiência, o nonce e a expiração do token.
  - Só entram contas que já existam na CMDB, identificadas pelo email ou pelo nome de utilizador.
- **2FA (TOTP)** com código QR, compatível com Microsoft/Google Authenticator, Authy e 1Password:
  - 10 códigos de recuperação de uso único;
  - proteção contra reutilização do mesmo código;
  - o administrador pode repor o 2FA de um utilizador;
  - com `CMDB_REQUIRE_2FA=1`, passa a ser obrigatório para quem entra com password.
- **Política de passwords:** mínimo de 10 caracteres, pelo menos dois tipos de caracteres, sem passwords comuns
  nem o nome de utilizador. O `admin` criado com a password por omissão (`admin123`) é **obrigado a mudá-la** no
  primeiro login, e o servidor avisa no arranque enquanto isso não acontecer. Um administrador pode obrigar qualquer
  utilizador a mudar a password no próximo login.
- **Passwords e segredos:** as passwords são guardadas com `scrypt`. O segredo dos conectores e o segredo de 2FA ficam encriptados na BD com AES-256-GCM.
- **Sessões:** o cookie é `HttpOnly` e `SameSite=Strict`.
- **Pedidos:** proteção CSRF por verificação de `Origin`, login limitado contra tentativas repetidas, todo o SQL com parâmetros e uma CSP restritiva. A interface não usa `innerHTML`.

## Configuração (variáveis de ambiente)

Ver [.env.example](.env.example) para a lista completa.

| Variável | Predefinição | Descrição |
|---|---|---|
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Endereço de escuta (`0.0.0.0` atrás de um proxy ou em Docker) |
| `CMDB_DB` | `data/cmdb.db` | Ficheiro SQLite |
| `CMDB_SECRET_KEY` | ficheiro `secret.key` | Chave de encriptação dos segredos. **Faça backup juntamente com a BD.** |
| `CMDB_ADMIN_PASSWORD` | `admin123` | Password do `admin` no primeiro arranque |
| `CMDB_SECURE_COOKIE` | `0` | `1` com HTTPS |
| `CMDB_PUBLIC_URL` | — | URL pública (necessária para o SSO) |
| `CMDB_REQUIRE_2FA` | `0` | `1` torna o 2FA obrigatório |
| `CMDB_OIDC_ISSUER` / `_CLIENT_ID` / `_CLIENT_SECRET` / `_LABEL` | — | SSO (vazio = desativado) |
| `CMDB_SYNC_HOURS` | `24` | Intervalo das sincronizações Microsoft 365 / Azure |
| `CMDB_BACKUP_HOURS` / `_KEEP` / `_DIR` | `24` / `14` / `data/backups` | Cópias de segurança automáticas (`0` = desativar) |
| `CMDB_SMTP_HOST` / `_PORT` / `_USER` / `_PASS` / `_FROM` | — / `587` | Email (vazio = desativado) |
| `CMDB_DIGEST_WEEKDAY` / `_HOUR` | `1` (segunda) / `8` | Resumo semanal por email (`off` = desativar) |
| `CMDB_LOG_FORMAT` / `CMDB_LOG_LEVEL` | `text` / `info` | Registo de eventos (`json` para ferramentas de observabilidade) |
| `CMDB_SIGNUP` | `0` | `1` ativa o registo self-service de novas organizações |
| `CMDB_PLAN_MAX_CLIENTS` / `_CIS` / `_USERS` | — | Limites por omissão das novas organizações (vazio = sem limite) |
| `CMDB_AUDIT_RETENTION_DAYS` | `730` | Retenção da auditoria em dias (`0` = guardar tudo) |

### SSO com Microsoft Entra ID
1. Entra ID → *App registrations* → *New registration*, com o Redirect URI (Web) `https://<cmdb>/api/auth/oidc/callback`.
2. Crie um *client secret*.
3. Defina:
   - `CMDB_OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0`
   - `CMDB_OIDC_CLIENT_ID`
   - `CMDB_OIDC_CLIENT_SECRET`
   - `CMDB_PUBLIC_URL`
4. Em **Utilizadores**, registe cada pessoa com o mesmo email da conta Microsoft. Com SSO ativo, a password passa a ser opcional.

### Conector Microsoft 365 / Azure (no tenant de cada cliente)
1. Crie uma *App registration* (single tenant) e um *client secret*.
2. Em *API permissions → Microsoft Graph → Application*, adicione:
   - `Organization.Read.All` (licenças);
   - `DeviceManagementManagedDevices.Read.All` (Intune);

   e depois clique *Grant admin consent*.
3. Para o Azure, atribua à aplicação a função **Reader** em cada subscrição.
4. Na CMDB, abra **Clientes → (cliente) → Microsoft 365 / Azure → Ligar**.

## Agentes de inventário

Crie um token em **Clientes → (cliente) → Tokens de inventário**. O diálogo mostra os comandos prontos a copiar:

```powershell
# Windows
iwr https://cmdb.empresa.pt/agent/inventario.ps1 -OutFile inventario.ps1
powershell -ExecutionPolicy Bypass -File inventario.ps1 -Servidor https://cmdb.empresa.pt -Token cmdb_xxx [-Local "Sede"]
```
```sh
# Linux / macOS (como root, para ler o nº de série)
curl -fsSL https://cmdb.empresa.pt/agent/inventario.sh | sudo sh -s -- -s https://cmdb.empresa.pt -t cmdb_xxx [-l "Sede"]
```

Para manter o inventário atualizado, agende o agente: por GPO, Intune ou RMM em Windows, e por `cron` ou `launchd` em Linux/macOS.

### API de ingestão

```http
POST /api/v1/ingest
Authorization: Bearer cmdb_xxx
Content-Type: application/json

{ "assets": [ { "external_id": "UUID", "hostname": "PC-001", "serial_number": "ABC123", "type": "Portátil",
                "site": "Sede", "manufacturer": "Lenovo", "model": "T14", "os": "Windows 11 Pro",
                "ip_address": "10.0.0.5", "attributes": { "ram_gb": 16 } } ] }
```

### API de importação

`POST /api/import` com `{ client_id, rows: [{ "Nome": …, "Tipo": … }], dry_run, update, create_sites }`.
Exige sessão de técnico ou administrador. Por omissão, `dry_run` é `true`: o pedido só simula e não grava nada.

## API pública (v1)

- As integrações usam **`/api/v1/…`**. A documentação OpenAPI 3.1 é gerada a partir das próprias rotas e está em
  **`GET /api/v1/openapi.json`** (sem autenticação).
- Os caminhos antigos (`/api/ingest`, `/api/integrations/…`) continuam a funcionar, com os cabeçalhos
  `Deprecation: true` e `Link: </api/v1/…>; rel="successor-version"`.
- **Permissões dos tokens:** `ingest` (agentes de inventário) e/ou `tickets` (helpdesk). Escolhem-se ao criar o token;
  um token sem a permissão recebe `403`. Os tokens criados antes desta versão têm as duas.
- **Validação declarativa:** cada pedido é validado por um esquema (`src/schema.js`; esquemas em `src/schemas.js` e
  `src/api-schemas.js`). Campos desconhecidos são descartados e os erros vêm em `{ "error": "…" }`, com código `400`.

## Integração com tickets

Use um token do cliente (o mesmo tipo dos agentes, criado em **Clientes → (cliente) → Tokens**). Na ferramenta de
helpdesk, configure um webhook/automação na criação e atualização de tickets:

```http
POST /api/v1/integrations/tickets
Authorization: Bearer cmdb_xxx
Content-Type: application/json

{ "system": "GLPI", "external_id": "4711", "title": "ERP não arranca", "status": "Em curso",
  "priority": "Alta", "url": "https://glpi.empresa.pt/front/ticket.form.php?id=4711",
  "cis": [ { "hostname": "SRV-ERP" }, { "serial_number": "ABC123" }, "PC-001" ] }
```

- Os ativos são procurados, dentro do cliente do token, por `id`, `hostname`, `serial_number`, `asset_tag` ou `name`
  (um texto simples tenta todos, e também o IP).
- A resposta inclui, para cada ativo, a **análise de impacto** (`impacted_count`, `max_criticality` e a lista de
  afetados), para a ferramenta poder ajustar a prioridade. Os ativos não encontrados vêm em `unmatched`.
- Enviar de novo o mesmo `system` + `external_id` atualiza o ticket. Estados como *Resolvido*, *Fechado*, *Closed*
  ou *Resolved* marcam-no como fechado (ou envie `"closed": true`).
- Para mostrar dados da CMDB na ferramenta: `GET /api/v1/integrations/cis?q=srv-erp` (mesmo token, permissão `tickets`) devolve os ativos
  correspondentes, com o impacto e o nº de tickets abertos.

## Produção

- Use o `docker-compose.yml`, que inclui um serviço Caddy opcional com HTTPS automático, ou outro reverse proxy, e defina `CMDB_SECURE_COOKIE=1`.
- **Backups:** automáticos a cada 24 h em `data/backups` (ou `CMDB_BACKUP_DIR`), mantendo as 14 mais recentes.
  Cada cópia é feita com o servidor a correr (`VACUUM INTO`), verificada (`integrity_check`) e acompanhada do
  `secret.key`. **Copie a pasta para fora do servidor** (outro disco, NAS ou cloud). Em **Administração → Sistema**
  vê as cópias existentes e pode criar uma na hora. Se usar `CMDB_SECRET_KEY`, guarde esse valor à parte: sem a
  chave, os segredos dos conectores e o 2FA deixam de funcionar.
  Para restaurar: pare o servidor, substitua `cmdb.db` pela cópia (apague `cmdb.db-wal`/`-shm`) e reponha o `secret.key`.
- **Email:** com `CMDB_SMTP_*` configurado, administradores e técnicos com email recebem à segunda-feira um resumo dos
  seus clientes (garantias e contratos a expirar, agentes sem contacto, conectores com erros). Resumos vazios não são
  enviados; cada pessoa pode desligá-lo em **A minha conta**. Teste o envio em **Administração → Sistema**.
- **Monitorização:** `GET /api/health` devolve `{ ok, db, version, uptime_s }` (503 se a BD não responder).
  Com `CMDB_LOG_FORMAT=json`, cada evento é uma linha JSON; com `CMDB_LOG_LEVEL=debug`, todos os pedidos à API são registados.

## Escala e operação

- **Tarefas pesadas fora do pedido** (`src/jobs.js`): o relatório Excel, a importação e as cópias de segurança correm
  numa *worker thread* com a sua própria ligação à BD (no máximo 2 em simultâneo). Uma importação de 5000 linhas não
  bloqueia os outros pedidos.
- **Várias instâncias** atrás de um balanceador: as sessões, as tentativas de login, o 2FA pendente e os *locks*
  estão na BD (`src/state.js`). Cada tarefa agendada (cópias, resumo, retenção) corre numa só instância.
- **Pesquisa** com índice FTS5 *trigram*: encontra qualquer parte do nome, hostname, nº de série, IP, modelo ou notas,
  sem distinguir maiúsculas nem acentos.
- **Listas paginadas** (ativos, contratos, auditoria por cursor) e retenção da auditoria (`CMDB_AUDIT_RETENTION_DAYS`).
- **Migrações numeradas** (`src/migrations.js`, tabela `schema_migrations`): aplicadas no arranque, cada uma uma vez e
  numa transação. A versão do esquema aparece em Administração → Sistema.
- **Camada de dados** (`src/store.js`): todo o SQL passa por ela. O caminho para PostgreSQL está em
  [`docs/postgresql.md`](docs/postgresql.md).

## Desenvolvimento

- **Testes:** `npm test`. Inclui os testes de browser (`test/e2e.test.js`, com Edge/Chrome headless; ignorados se não
  houver browser).
- **Tipos:** `npm run typecheck` verifica todo o JavaScript (servidor e interface) com o TypeScript a partir de JSDoc,
  sem passo de build. As ferramentas não ficam como dependências da aplicação.
- **Interface:** ES modules nativos (`public/js/main.js` importa o núcleo e as vistas); `index.html` carrega um único
  `<script type="module">`.
- **CI:** `.github/workflows/ci.yml` corre os testes em Node 22 e 24, a verificação de tipos, constrói a imagem Docker e
  confirma o *health check*.

## Estrutura

```
server.js              arranque, tarefas agendadas (sincronização, backups, resumo semanal), logs
src/app.js             sessões, router (validação, /api/v1), registo das rotas, ficheiros estáticos
src/access.js          controlo de acesso: organização, cliente, plataforma, limites do plano
src/store.js           camada de dados (one/all/run/tx, auditoria, dialeto SQL, pesquisa FTS5)
src/migrations.js      migrações numeradas do esquema (a 1, esquema base, está em db.js)
src/state.js           estado partilhado entre instâncias (tentativas, 2FA pendente, locks)
src/jobs.js            tarefas em worker threads (Excel, importação, cópias); src/job-worker.js
src/schema.js          validação declarativa e JSON Schema; schemas.js e api-schemas.js com os esquemas
src/validators.js      validação de ativos sem acesso à BD
src/reports-data.js    dados e Excel dos relatórios
src/http.js            constantes, erros HTTP e validação
src/routes/            rotas da API, um ficheiro por área:
  auth.js                login, 2FA, SSO, conta        cis.js        ativos, relações, impacto, dashboard
  clients.js             clientes, locais, tokens      users.js      utilizadores e auditoria
  inventory.js           agentes e importação          connectors.js Microsoft 365 / Azure
  contracts.js           contratos                     reports.js    relatórios (JSON e Excel)
  tickets.js             tickets e webhook             search.js     pesquisa global
  system.js              health, sistema, backups, email   orgs.js    organizações, registo, plataforma
  api-docs.js            OpenAPI da API pública
src/db.js              esquema SQLite e migrações
src/auth.js            hashing, tokens, encriptação de segredos
src/passwords.js       política de passwords
src/backup.js          cópias de segurança
src/mailer.js          cliente SMTP
src/xlsx.js            gerador de Excel
src/log.js             registo de eventos (texto ou JSON)
src/totp.js            2FA (RFC 6238)
src/oidc.js            SSO OpenID Connect
src/reconcile.js       reconciliação de ativos descobertos
src/importer.js        importação CSV/Excel
src/cloud.js           conector Microsoft 365 / Intune / Azure
public/js/core.js      interface: estado, DOM, API, diálogos
public/js/auth.js      login e "A minha conta"
public/js/views/       páginas (dashboard, clientes, ativos, contratos, relatórios, importação, administração, sistema, organizações)
public/js/main.js      layout, router, atalhos, pesquisa global, arranque
public/js/icons.js     ícones (Tabler Icons) usados pela interface
public/js/theme.js     tema claro/escuro conforme o sistema operativo
public/app.css         cor da marca, Inter e estilos próprios (mapa, pesquisa, impressão)
public/vendor/         Tabler, Inter (com licenças)
public/                qr.js, files.js, graph.js, favicon.svg
brand/                 logótipo, ícones e sistema de design (brand/design-system: node build.js)
scripts/screenshots.js capturas de ecrã das páginas principais (Edge/Chrome headless)
agent/                 agentes Windows e Linux/macOS
test/                  testes (node:test); e2e.test.js usa Edge/Chrome headless se existir (CMDB_BROWSER)
docs/                  documentação técnica (postgresql.md)
.github/workflows/     integração contínua
Dockerfile, docker-compose.yml, .env.example
```

## Licença

MIT. Ver [LICENSE](LICENSE).
