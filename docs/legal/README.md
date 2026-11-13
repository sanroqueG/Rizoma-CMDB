# Documentos legais (rascunhos)

> **Rascunhos para revisão jurídica.** Não publique sem a revisão de um advogado.
> Os campos entre `[ ]` têm de ser preenchidos.

| Documento | Para quê | Publicar em |
|---|---|---|
| [termos-de-servico.md](termos-de-servico.md) | Contrato entre o Rizoma e a organização cliente | `CMDB_TERMS_URL` |
| [politica-de-privacidade.md](politica-de-privacidade.md) | Dados pessoais de que o Rizoma é **responsável** (contas, faturação, site) | `CMDB_PRIVACY_URL` |
| [acordo-tratamento-dados.md](acordo-tratamento-dados.md) | DPA (art. 28.º RGPD): dados que os clientes guardam no Rizoma, de que o Rizoma é **subcontratante** | Anexo aos termos |

Com `CMDB_TERMS_URL` definido, o registo exige a aceitação e guarda a data e a versão (`CMDB_TERMS_VERSION`)
de cada administrador que cria uma organização. Mude a versão sempre que os termos mudarem.

## O que o produto já cumpre

- **Portabilidade (art. 20.º):** exportação de todos os dados da organização em JSON (Organização → Exportar).
- **Apagamento (art. 17.º):** a organização pede a eliminação; fica só de leitura durante 30 dias e depois é
  apagada por completo (todas as tabelas, em cascata). As cópias de segurança expiram pela retenção configurada
  (`CMDB_BACKUP_KEEP`): indique esse prazo na política.
- **Segurança (art. 32.º):** passwords com scrypt, segredos encriptados (AES-256-GCM), 2FA, SSO, isolamento entre
  organizações testado, auditoria, HTTPS (configuração do servidor).
- **Registo de atividades:** auditoria por organização, com retenção configurável (`CMDB_AUDIT_RETENTION_DAYS`).

## A decidir antes de publicar

- Entidade jurídica, sede, NIF e contacto do encarregado de proteção de dados (se aplicável).
- Onde fica alojado (preferir a UE) e a lista de subcontratantes ulteriores (alojamento, Stripe, email).
- Prazo de retenção das cópias de segurança e período de aviso para alterações aos termos.
- Limitação de responsabilidade e lei aplicável (rever com o advogado).
