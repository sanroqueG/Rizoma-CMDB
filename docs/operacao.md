# Operar o Rizoma como serviço

Guia para quem aloja o Rizoma para clientes (SaaS). As variáveis estão em `.env.example`.

## Cópias de segurança fora do servidor

As cópias locais (`CMDB_BACKUP_HOURS`, `CMDB_BACKUP_KEEP`) protegem contra erros, não contra a perda do servidor.
Use **pelo menos uma** destas opções:

### 1. Enviar cada cópia (simples)

`CMDB_BACKUP_UPLOAD_CMD` corre depois de cada cópia, com o caminho em `$BACKUP_FILE`
(e o da chave de encriptação em `$BACKUP_KEY_FILE`):

```sh
# rclone (S3, Backblaze B2, Azure, Google Cloud, SFTP…)
CMDB_BACKUP_UPLOAD_CMD='rclone copy "$BACKUP_FILE" remoto:rizoma-backups/'
# AWS CLI
CMDB_BACKUP_UPLOAD_CMD='aws s3 cp "$BACKUP_FILE" s3://rizoma-backups/'
```

Um envio falhado fica no log (`Envio da cópia para fora do servidor falhou`) e na métrica
`rizoma_backup_uploads_total{result="erro"}`. Configure no armazenamento a retenção e, se possível, o bloqueio
de objetos (proteção contra ransomware). **Guarde a `secret.key` noutro sítio**: sem ela, os segredos
encriptados (conectores, 2FA) da cópia não se recuperam.

### 2. Replicação contínua com Litestream (recomendado em produção)

O [Litestream](https://litestream.io) replica o WAL do SQLite para S3 a cada segundo: perde-se, no máximo,
alguns segundos de dados. Exemplo de `litestream.yml`:

```yaml
dbs:
  - path: /app/data/cmdb.db
    replicas:
      - url: s3://rizoma-backups/cmdb
        retention: 720h
```

No Docker, corra o Rizoma através do Litestream (`litestream replicate -exec "node server.js"`).
Para repor: `litestream restore -o data/cmdb.db s3://rizoma-backups/cmdb`.

### Repor uma só organização

Quando um cliente apaga dados por engano, reponha só essa organização a partir de uma cópia, sem tocar nas outras:

```sh
node scripts/restore-org.js --backup data/backups/cmdb-2026-11-12.db --org acme           # mostra o que muda
node scripts/restore-org.js --backup data/backups/cmdb-2026-11-12.db --org acme --apply   # repõe
```

Os dados da organização voltam ao estado da cópia (incluindo utilizadores; as sessões terminam). A organização,
a subscrição e a auditoria mantêm-se, e a reposição fica registada. Faça uma cópia da BD atual antes.

## Monitorização

- **Saúde:** `GET /api/health` (200 com a BD a responder, 503 sem ela). Use-o no balanceador e num serviço de
  monitorização externo (UptimeRobot, Better Stack) para a página de estado.
- **Métricas:** com `CMDB_METRICS_TOKEN`, `GET /api/metrics` devolve métricas Prometheus
  (`Authorization: Bearer <token>`): pedidos por rota e estado, duração, cópias, organizações, utilizadores, ativos,
  tamanho da BD. Exemplo de configuração:

  ```yaml
  scrape_configs:
    - job_name: rizoma
      metrics_path: /api/metrics
      authorization: { credentials: <token> }
      static_configs: [{ targets: ['app.rizoma.pt'] }]
      scheme: https
  ```

- **Alertas sugeridos:** taxa de respostas 5xx > 1 % durante 5 minutos; `rizoma_backups_total{result="erro"}` a
  aumentar; nenhuma cópia nas últimas 26 horas; `rizoma_db_bytes` acima de 80 % do disco.
- **Logs:** JSON numa linha (`CMDB_LOG_FORMAT=json`), prontos para Loki, Datadog ou CloudWatch.

## Email transacional

Convites, recuperação de password, verificação e resumos semanais saem por SMTP (`CMDB_SMTP_*`). Em produção, use
um fornecedor transacional (Postmark, Amazon SES, Brevo, Mailgun): todos têm SMTP.

1. Envie de um domínio próprio (ex.: `rizoma@mail.rizoma.pt`) e verifique-o no fornecedor.
2. Publique no DNS os registos **SPF** e **DKIM** que o fornecedor indicar, e um **DMARC**
   (`_dmarc.mail.rizoma.pt TXT "v=DMARC1; p=quarantine; rua=mailto:dmarc@rizoma.pt"`).
3. Defina `CMDB_PUBLIC_URL` com o endereço público: é com ele que as ligações dos emails são construídas.
4. Teste em Sistema → Email de teste e confirme que não cai no spam (ex.: mail-tester.com).

## Acesso de suporte

A equipa da plataforma só entra numa organização se um administrador dela o autorizar
(Organização → Acesso de suporte, até 7 dias, revogável). Em Plataforma, "Entrar (suporte)" abre uma sessão de no
máximo 1 hora como administrador dessa organização. Tudo o que for feito fica na auditoria da organização com o
autor `suporte:<utilizador>`. A sessão não pode alterar a conta do administrador, a subscrição, o pedido de
eliminação nem a autorização.

## Eliminação de organizações (RGPD)

Pedidos de eliminação ficam 30 dias em modo só de leitura e depois são apagados por uma tarefa diária
(com lock, numa só instância). As cópias de segurança expiram pela retenção: indique esse prazo na política de
privacidade (ver `docs/legal/`).
