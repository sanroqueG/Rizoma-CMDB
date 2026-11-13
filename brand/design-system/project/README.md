Rizoma é a CMDB para prestadores de serviços de TI que gerem a infraestrutura de vários clientes: inventário, relações entre ativos, análise de impacto, contratos e renovações, com os dados de cada cliente isolados. Um rizoma é uma raiz que cresce em rede, sem centro, ligando cada rebento aos outros. É assim que o produto mostra a infraestrutura: cada ativo ligado ao que depende dele.

A interface é construída com o **Tabler** (https://tabler.io, licença MIT), um kit open source de dashboards sobre Bootstrap 5. A marca não inventa componentes próprios. Usa os do Tabler tal como são, com três escolhas de marca por cima: o verde-petróleo `primary`, o tipo de letra Inter e o logótipo.

## Regra principal: usar o Tabler, não reinventá-lo

- Construa cada ecrã com as classes do Tabler: `page`, `navbar-vertical`, `page-header`, `page-title`, `card`, `card-header`, `card-title`, `table card-table table-vcenter`, `btn`, `badge bg-*-lt`, `status status-*`, `form-control`, `form-select`, `form-check`, `alert`, `list-group`, `progress`.
- Não escreva CSS para botões, cartões, tabelas ou formulários. O CSS próprio do Rizoma cobre só a cor da marca, o tipo de letra e o que o Tabler não tem: o mapa de relações, a pesquisa global e a impressão de relatórios.
- Antes de desenhar um padrão novo, procure-o em https://preview.tabler.io e copie a estrutura.
- Ícones: **Tabler Icons** (outline, traço 2, 24px). Ver Iconografia.

## Nome e assinatura

- Escreva **Rizoma** com maiúscula inicial em texto corrido. No logótipo o nome aparece em minúsculas ("rizoma"); não o reproduza assim em texto.
- O nome leva artigo masculino: "o Rizoma mostra…", "no Rizoma".
- Descritor, quando o nome sozinho não chega: **Rizoma · CMDB multi-cliente para prestadores de serviços de TI**.
- Assinatura de marketing: **Toda a infraestrutura, ligada.** Use-a no site, em apresentações e propostas, nunca dentro da aplicação.

## Voz e conteúdo

O Rizoma fala como um técnico experiente: direto, exato e calmo.

- **Português de Portugal**, com tratamento formal e impessoal no imperativo ("Introduza", "Escolha", "Copie"). Nunca "tu"; nunca "você" escrito.
- **Frases curtas e em maiúscula inicial** (sem Title Case). Os botões dizem o que acontece: "Guardar alterações", "Ligar ticket", "Criar cópia agora". A confirmação é curta: "Contrato criado."
- **Números com unidade e prazo reais**: "há 12 d", "em 45 d", "1 180,00 €". Datas em `DD/MM/AAAA` na interface e `AAAA-MM-DD` em exportações.
- **Os erros dizem como resolver**: "Código inválido. Confirme que a hora do telemóvel está certa e tente novamente." Sem pedidos de desculpa e sem pontos de exclamação.
- **Sem emoji** e sem superlativos ("revolucionário", "o melhor").
- Exemplos da aplicação: "Requer atenção", "Nada pendente", "Copie o token agora. Por segurança, não volta a ser mostrado."

## Logótipo

O símbolo é um rizoma desenhado com o traço dos Tabler Icons: um caule horizontal, dois rebentos com nó e duas raízes, numa placa `primary` com cantos arredondados.

- `rizoma-logotipo.svg`: símbolo + "rizoma" (Inter Bold, em contornos) em `text` (#1f2937), para fundos claros.
- `rizoma-logotipo-negativo.svg`: a mesma versão com o nome em branco, para a barra lateral e fundos escuros.
- `rizoma-simbolo.svg`: ícone da aplicação, favicon e avatar em redes sociais.
- `rizoma-simbolo-mono.svg`: só o traço, numa tinta, para gravação, carimbos e documentos a uma cor.
- **Área de proteção**: à volta do logótipo, metade da altura do símbolo. **Tamanho mínimo**: símbolo com 16px; logótipo com 96px de largura.
- **Não faça**: mudar a cor da placa, rodar o símbolo, recompor o nome noutro tipo de letra, aplicar sombras ou contornos.

## Cor

- **`primary` (verde-petróleo #0f6b73)**: a cor da marca, sempre com `on-primary` (branco) por cima. Use-a no botão primário (**um por vista**), no item ativo da navegação, nas barras de progresso e nas ligações (`link`). Não pinte cartões nem cabeçalhos inteiros de verde-petróleo.
- **Neutros do Tabler**: `body-bg` para o fundo, `surface` para cartões, `border` para contornos, `text` para o texto principal e `text-secondary` para o secundário. A barra lateral (`sidebar`) é escura nos dois temas.
- **Cores de estado** (do Tabler): `success` (verde), `warning` (laranja), `danger` (vermelho) e `info` (azure). Servem só para estados, nunca para decoração. Em etiquetas use as variantes claras (`badge bg-green-lt`, `bg-orange-lt`, `bg-red-lt`, `bg-azure-lt`). No tema claro, o texto destas etiquetas e dos estados é escurecido para chegar a 5:1 (ver notas dos tokens).
- O estado nunca depende só da cor: há sempre uma palavra ("Em produção", "Expirada") e, nos estados de ativo, um ponto.
- **Tema escuro**: o do Tabler (`data-bs-theme="dark"`), ativado pela preferência do sistema. As ligações passam a `#5cc2c9`.

## Tipografia

- **Inter** (licença OFL, ficheiros em `fonts/`), o tipo de letra para que o Tabler foi desenhado: 400 para texto, 500 para botões e navegação, 600 para títulos, 700 para o logótipo e títulos de site.
- Escala: `page-title` 20px · `card-title` 16px · `body` 14px · `small` 12px · `subheader` 12px em maiúsculas.
- Números em tabelas e indicadores com `font-variant-numeric: tabular-nums`. Dados técnicos (IP, nº de série, tokens) em `.font-monospace`.

## Estrutura de ecrã

- **Navegação**: `navbar-vertical` escura à esquerda, com o logótipo negativo, a pesquisa (Ctrl K), os grupos "Inventário" e "Administração" e o utilizador no fundo.
- **Cabeçalho de página**: `page-header` com caminho (`breadcrumb`), título (`page-title`), uma linha de contexto em `text-secondary` e as ações à direita (`btn-list`). A ação primária fica em último lugar, à direita.
- **Corpo**: `container-xl`, com cartões em `row row-cards`. Fichas em duas colunas: dados à esquerda (`col-lg-7`) e relações, impacto e histórico à direita (`col-lg-5`).
- **Listas**: tabela dentro de cartão (`card-table`), filtros numa linha por cima (`card-body border-bottom`) e paginação no `card-footer`.
- **Diálogos**: modal do Tabler, com a ação principal à direita e "Cancelar" à esquerda.

## Iconografia

- **Tabler Icons**, outline, 24×24, traço 2, pontas e cantos arredondados, cor `currentColor`. Mesma família do símbolo, por isso não misture outras.
- Na navegação, cada área tem um ícone fixo (ver **Icons**). Nos botões, o ícone vem antes do texto e só quando ajuda a reconhecer a ação (adicionar, editar, eliminar, exportar, imprimir).
- Sem emoji.

## Aplicações

- **Site**: fundo `body-bg`, logótipo no topo, título em `display`, capturas reais da aplicação dentro de um cartão com `radius-lg`. Botão primário em `primary`.
- **Apresentações**: capa com o logótipo negativo sobre `sidebar`; diapositivos interiores claros, com capturas da aplicação.
- **Email (resumo semanal)**: fundo branco, linha de 3px em `primary` no topo, "rizoma" em `primary` e texto em `text`.
- **Relatórios PDF**: gerados pela própria página de relatório (Imprimir), com o símbolo no cabeçalho e tabelas do Tabler.
