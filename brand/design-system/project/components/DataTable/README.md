# DataTable

Tabela do Tabler dentro de cartão: `table table-vcenter card-table table-hover` num `table-responsive`.

- A primeira coluna é a ligação para o registo; o contexto (local, hostname) vai por baixo em `text-secondary small`.
- Valores e prazos alinhados à direita (`text-end`); IP e nº de série em `font-monospace small`.
- Células vazias mostram "—". Sem linhas, uma única célula em `text-secondary` diz o que falta ("Nenhum ativo encontrado.").
- Filtros numa linha acima da tabela (`card-body border-bottom`); paginação no `card-footer` com `pagination`.
- Ordene pelo que exige atenção primeiro.
