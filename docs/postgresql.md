# Passar de SQLite para PostgreSQL

O Rizoma usa SQLite (um ficheiro, sem servidor) e aguenta bem uma plataforma com dezenas de organizações e
centenas de milhares de ativos numa só máquina. Este documento descreve o que muda quando for preciso
PostgreSQL: alta disponibilidade, várias máquinas a escrever ao mesmo tempo, ou réplicas de leitura.

## O que já está preparado

- **Uma só porta de entrada para a BD.** Todo o SQL passa por `src/store.js` (`one`, `all`, `run`, `tx`,
  `audit`). Nenhuma rota usa `db.prepare` diretamente; o teste de isolamento e a revisão de código devem
  manter isto assim.
- **Fragmentos de dialeto centralizados.** `store.sql` (`core.sqlDialect` nas rotas) tem `now`, `today`,
  `dateOffset`, `datetimeOffset`, `groupConcat`, `insertIgnore` e `likeEscape`. O SQL novo deve usá-los.
- **Migrações numeradas** (`src/migrations.js`): a mesma sequência pode ser escrita para PostgreSQL.
- **Estado partilhado na BD** (`src/state.js`): sessões, tentativas de login, 2FA pendente e locks já
  funcionam com várias instâncias.
- **Tarefas pesadas fora do pedido** (`src/jobs.js`): no PostgreSQL passam a ser simplesmente assíncronas.

## O que falta fazer

1. **Acesso assíncrono.** O `node:sqlite` é síncrono; o driver `pg` é assíncrono. `one/all/run/tx` passam a
   devolver Promises e cada chamada nas rotas ganha `await` (os handlers já podem ser `async`). `tx` usa um
   cliente do pool com `BEGIN/COMMIT`.
2. **Dialeto SQL** (inventário à data desta versão):

   | SQLite | PostgreSQL | Ocorrências |
   |---|---|---|
   | `datetime('now')` | `now()` (ou `to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')` para manter o formato texto) | 25 |
   | `date('now', '+30 days')` | `current_date + interval '30 days'` | 8 |
   | `COLLATE NOCASE` | `citext` ou `lower(...)` com índice funcional | 13 |
   | `LIKE ... ESCAPE '\'` | `ILIKE ... ESCAPE '\'` | 11 |
   | `INSERT OR IGNORE` | `INSERT ... ON CONFLICT DO NOTHING` | 4 |
   | `group_concat(x, ', ')` | `string_agg(x, ', ')` | 2 |
   | parâmetros `?` | `$1, $2, …` (converter no `store`) | todos |
   | `lastInsertRowid` | `INSERT ... RETURNING id` | ~20 |

3. **Pesquisa.** A tabela virtual `cis_fts` (FTS5 trigram) é substituída pela extensão `pg_trgm`, com um
   índice GIN sobre as mesmas colunas. `store.ciTextFilter` é o único sítio a mudar.
4. **Datas guardadas como texto.** O SQLite guarda `TEXT` (`AAAA-MM-DD HH:MM:SS`). No PostgreSQL, usar
   `timestamptz` e `date`, e ajustar as comparações.
5. **Isolamento reforçado (opcional).** Com PostgreSQL pode-se acrescentar *Row Level Security* por
   `org_id`, como segunda barreira atrás de `src/access.js`.
6. **Migração dos dados.** Exportar cada organização com `GET /api/org/export` (ou um script sobre a BD
   SQLite) e importar para o esquema PostgreSQL, preservando os ids.

## Quando fazer esta mudança

Quando uma destas situações se verificar:
- é preciso mais do que uma máquina a servir pedidos com escrita;
- a BD passa de alguns GB e as cópias de segurança completas ficam lentas;
- a plataforma precisa de *failover* automático.

Até lá, uma instância com SQLite, as cópias de segurança automáticas e réplicas por cópia de ficheiro
(por exemplo, Litestream) são mais simples de operar.
