'use strict';
/*
 * Gera os ficheiros do sistema de design Rizoma a partir da aplicação:
 *  - components/bundle.css = CSS do Tabler (public/vendor) + ligação aos tokens da marca
 *  - fonts/ = Inter (public/vendor/inter)
 *  - components/<Comp>/README.md e preview.html (HTML com classes Tabler e Tabler Icons)
 * Correr: node build.js
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', '..');
const out = path.join(__dirname, 'project');
const vendor = path.join(root, 'public', 'vendor');

// ------------------------------------------------------------------ ícones (os mesmos da aplicação)
const iconsSrc = fs.readFileSync(path.join(root, 'public', 'js', 'icons.js'), 'utf8');
const ICONS = JSON.parse(iconsSrc.slice(iconsSrc.indexOf('{'), iconsSrc.lastIndexOf('}') + 1));
const icon = (name, cls = 'icon') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${
  ICONS[name].map(([t, a]) => `<${t} ${Object.entries(a).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('')}</svg>`;
const mark = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="var(--primary)"/><path d="M6 18h20M10 18v-6M17 18l3.5-7M13 18l-2 6M22 18l2 5" fill="none" stroke="var(--on-primary)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10" cy="10.5" r="2.2" fill="var(--on-primary)"/><circle cx="21.2" cy="9.6" r="2.2" fill="var(--on-primary)"/></svg>`;

// ------------------------------------------------------------------ bundle.css
const tabler = fs.readFileSync(path.join(vendor, 'tabler', 'tabler.min.css'), 'utf8');
const brand = `
/* ===== Rizoma: Tabler 1.4.0 (MIT) ligado aos tokens da marca (tokens.css) ===== */
:root, [data-theme] {
  --tblr-primary: var(--primary); --tblr-primary-rgb: 15, 107, 115; --tblr-primary-darken: var(--primary-hover);
  --tblr-primary-fg: var(--on-primary); --tblr-primary-lt: var(--primary-lt);
  --tblr-link-color: var(--link); --tblr-link-hover-color: var(--primary-hover);
  --tblr-body-bg: var(--body-bg); --tblr-bg-surface: var(--surface); --tblr-bg-surface-primary: var(--surface);
  --tblr-bg-surface-secondary: var(--surface-secondary); --tblr-border-color: var(--border);
  --tblr-body-color: var(--text); --tblr-emphasis-color: var(--text); --tblr-secondary: var(--text-secondary); --tblr-secondary-color: var(--text-secondary);
  --tblr-green: var(--success); --tblr-orange: var(--warning); --tblr-red: var(--danger); --tblr-azure: var(--info);
  --tblr-font-sans-serif: var(--font-sans); --tblr-border-radius: var(--radius); --tblr-border-radius-sm: var(--radius-sm); --tblr-border-radius-lg: var(--radius-lg);
}
[data-theme="dark"] { color-scheme: dark; }
body { background: var(--body-bg); color: var(--text); font-family: var(--font-sans); }
.ds-pad { padding: 16px; }
/* texto de estado mais escuro no tema claro (contraste ≥ 5:1); igual à aplicação */
[data-theme="light"] .bg-green-lt { color: #1a7a2b !important; }
[data-theme="light"] .bg-orange-lt { color: #b04604 !important; }
[data-theme="light"] .bg-red-lt { color: #b02a2a !important; }
[data-theme="light"] .bg-azure-lt { color: #1f68a8 !important; }
[data-theme="light"] .bg-secondary-lt { color: #4b5563 !important; }
[data-theme="light"] .status { color: color-mix(in srgb, var(--tblr-status-color) 62%, #000); }
.navbar-vertical.ds-sidebar { position: static; width: 240px; min-height: 0; background: var(--sidebar); }
.brand-word { font-weight: 700; font-size: 1.25rem; letter-spacing: -.01em; }
`;
fs.mkdirSync(path.join(out, 'components'), { recursive: true });
fs.writeFileSync(path.join(out, 'components', 'bundle.css'), tabler + '\n' + brand);

// ------------------------------------------------------------------ fontes
fs.mkdirSync(path.join(out, 'fonts'), { recursive: true });
for (const w of [400, 500, 600, 700]) fs.copyFileSync(path.join(vendor, 'inter', `inter-latin-${w}.woff2`), path.join(out, 'fonts', `inter-latin-${w}.woff2`));

// ------------------------------------------------------------------ componentes
const C = {
  Button: {
    group: 'Ações', height: 80,
    html: `<div class="ds-pad btn-list">
  <button class="btn btn-primary">${icon('plus')}Novo ativo</button>
  <button class="btn">${icon('download')}Exportar CSV</button>
  <button class="btn">Cancelar</button>
  <button class="btn btn-outline-danger">${icon('trash')}Eliminar</button>
  <button class="btn btn-sm">${icon('link')}Adicionar relação</button>
  <button class="btn btn-link">Editar</button>
  <button class="btn btn-primary" disabled>Guardar alterações</button>
</div>`,
    readme: `# Button

Botões do Tabler (\`btn\`), com 6px de raio e 500 de peso.

- \`btn btn-primary\`: a ação principal da vista, **uma por vista**, sempre a última à direita no cabeçalho ou no rodapé do formulário.
- \`btn\` (contorno): ações secundárias ("Exportar CSV", "Relatório", "Cancelar").
- \`btn btn-outline-danger\`: eliminar, revogar, remover. Peça sempre confirmação num modal que nomeie o que vai ser eliminado.
- \`btn btn-sm\`: ações dentro do cabeçalho de um cartão (\`card-actions\`).
- \`btn btn-link\`: ações em linha dentro de tabelas ("Editar", "Remover").
- Ícone (Tabler Icons, classe \`icon\`) antes do texto, só quando ajuda a reconhecer a ação.
- O rótulo começa por verbo e diz o que acontece. Nunca "OK" nem "Submeter".
- Agrupe botões em \`btn-list\`.
`,
  },
  Badge: {
    group: 'Estados', height: 72,
    html: `<div class="ds-pad d-flex flex-wrap gap-2 align-items-center">
  <span class="badge bg-secondary-lt">Licença</span>
  <span class="badge bg-azure-lt">Média</span>
  <span class="badge bg-green-lt">Ativo</span>
  <span class="badge bg-primary-lt">Agente</span>
  <span class="badge bg-orange-lt">Termina em 20 d</span>
  <span class="badge bg-red-lt">Garantia expirada</span>
  <span class="badge bg-red text-white">8</span>
</div>`,
    readme: `# Badge

Etiquetas do Tabler na variante clara (\`badge bg-<cor>-lt\`), para estados e categorias curtas.

- \`bg-secondary-lt\`: categoria neutra ("Licença", "Manual").
- \`bg-azure-lt\`: informação, criticidade média.
- \`bg-green-lt\`: confirmado ou ativo.
- \`bg-primary-lt\`: origem automática ("Agente", "Intune").
- \`bg-orange-lt\`: a vencer, criticidade alta.
- \`bg-red-lt\`: expirado, em falta, criticidade crítica.
- Preenchimento sólido (\`bg-red text-white\`) só para contadores no cabeçalho de um cartão.
- O texto diz o estado em palavras; a cor nunca é a única pista.
`,
  },
  Status: {
    group: 'Estados', height: 72,
    html: `<div class="ds-pad d-flex flex-wrap gap-2 align-items-center">
  <span class="status status-green"><span class="status-dot"></span>Em produção</span>
  <span class="status status-azure"><span class="status-dot"></span>Em stock</span>
  <span class="status status-secondary"><span class="status-dot"></span>Planeado</span>
  <span class="status status-orange"><span class="status-dot"></span>Em manutenção</span>
  <span class="status status-secondary text-decoration-line-through"><span class="status-dot"></span>Abatido</span>
</div>`,
    readme: `# Status

Estado de um ativo com o componente \`status\` do Tabler: ponto de cor + rótulo.

| Estado | Classe |
|---|---|
| Em produção | \`status status-green\` |
| Em stock | \`status status-azure\` |
| Planeado | \`status status-secondary\` |
| Em manutenção | \`status status-orange\` |
| Abatido | \`status status-secondary text-decoration-line-through\` |

- Use sempre o rótulo; o ponto sozinho não chega.
- Criticidade não é um estado: use \`Badge\` (Baixa \`bg-secondary-lt\`, Média \`bg-azure-lt\`, Alta \`bg-orange-lt\`, Crítica \`bg-red-lt\`).
`,
  },
  Card: {
    group: 'Estrutura', height: 230,
    html: `<div class="ds-pad"><div class="card" style="max-width:520px">
  <div class="card-header">
    <div><h3 class="card-title">Informação</h3><div class="text-secondary small mt-1">Acme Logística, S.A.</div></div>
    <div class="card-actions"><button class="btn btn-sm">${icon('edit')}Editar</button></div>
  </div>
  <div class="card-body">
    <dl class="row mb-0">
      <dt class="col-5 text-secondary fw-normal">Contacto</dt><dd class="col-7">Rita Fonseca</dd>
      <dt class="col-5 text-secondary fw-normal">Email</dt><dd class="col-7">it@acme.example</dd>
      <dt class="col-5 text-secondary fw-normal">Criado em</dt><dd class="col-7 mb-0">12/11/2026</dd>
    </dl>
  </div>
</div></div>`,
    readme: `# Card

Cartão do Tabler, a unidade de conteúdo de todos os ecrãs.

- Estrutura: \`card\` > \`card-header\` (\`card-title\`, subtítulo opcional em \`text-secondary small\`, ações em \`card-actions\`) > \`card-body\`.
- Uma tabela vai diretamente dentro do cartão, sem \`card-body\` (\`table card-table\`), para encostar às margens.
- Pares rótulo/valor: \`dl.row\` com \`dt.col-5.text-secondary.fw-normal\` e \`dd.col-7\`.
- Cartões lado a lado em \`row row-cards\`; numa ficha, dados à esquerda (\`col-lg-7\`) e relações/histórico à direita (\`col-lg-5\`).
- Não pinte cartões com a cor da marca nem lhes acrescente bordas coloridas.
`,
  },
  DataTable: {
    group: 'Dados', height: 240,
    html: `<div class="ds-pad"><div class="card"><div class="table-responsive"><table class="table table-vcenter card-table table-hover">
  <thead><tr><th>Nome</th><th>Tipo</th><th>Estado</th><th>Criticidade</th><th>IP</th><th class="text-end">Garantia</th></tr></thead>
  <tbody>
    <tr><td><a href="#">HV-LX-01</a><div class="text-secondary small">Sede Lisboa</div></td><td class="text-secondary">Servidor</td><td><span class="status status-green"><span class="status-dot"></span>Em produção</span></td><td><span class="badge bg-red-lt">Crítica</span></td><td class="text-secondary font-monospace small">10.10.1.10</td><td class="text-end">há 10 d</td></tr>
    <tr><td><a href="#">FW-LX-01</a><div class="text-secondary small">Sede Lisboa</div></td><td class="text-secondary">Firewall</td><td><span class="status status-green"><span class="status-dot"></span>Em produção</span></td><td><span class="badge bg-red-lt">Crítica</span></td><td class="text-secondary font-monospace small">10.10.0.1</td><td class="text-end">em 45 d</td></tr>
    <tr><td><a href="#">PRT-PT-01</a><div class="text-secondary small">Armazém Porto</div></td><td class="text-secondary">Impressora</td><td><span class="status status-orange"><span class="status-dot"></span>Em manutenção</span></td><td><span class="badge bg-azure-lt">Média</span></td><td class="text-secondary font-monospace small">10.20.0.50</td><td class="text-end">—</td></tr>
  </tbody></table></div></div></div>`,
    readme: `# DataTable

Tabela do Tabler dentro de cartão: \`table table-vcenter card-table table-hover\` num \`table-responsive\`.

- A primeira coluna é a ligação para o registo; o contexto (local, hostname) vai por baixo em \`text-secondary small\`.
- Valores e prazos alinhados à direita (\`text-end\`); IP e nº de série em \`font-monospace small\`.
- Células vazias mostram "—". Sem linhas, uma única célula em \`text-secondary\` diz o que falta ("Nenhum ativo encontrado.").
- Filtros numa linha acima da tabela (\`card-body border-bottom\`); paginação no \`card-footer\` com \`pagination\`.
- Ordene pelo que exige atenção primeiro.
`,
  },
  Field: {
    group: 'Formulários', height: 260,
    html: `<div class="ds-pad"><div class="row" style="max-width:720px">
  <div class="col-md-6 mb-3"><label class="form-label">Hostname</label><input class="form-control" value="SRV-ERP-SQL"><div class="form-hint">Como aparece na rede.</div></div>
  <div class="col-md-6 mb-3"><label class="form-label">Tipo</label><select class="form-select"><option>Máquina virtual</option></select></div>
  <div class="col-md-6 mb-3"><label class="form-label">Fim de garantia</label><input class="form-control is-invalid" value="31/02/2027"><div class="invalid-feedback">Data inválida. Use o formato DD/MM/AAAA.</div></div>
  <div class="col-md-6 mb-3 d-flex align-items-end"><label class="form-check form-switch mb-2"><input class="form-check-input" type="checkbox" checked><span class="form-check-label">Renovação automática</span></label></div>
</div></div>`,
    readme: `# Field

Campos do Tabler: \`form-label\` por cima, \`form-control\` / \`form-select\`, ajuda em \`form-hint\` e erro em \`invalid-feedback\` (com \`is-invalid\` no campo).

- O rótulo diz o que se pede ("Nº de série", "Fim de garantia"); campos obrigatórios com " *".
- Organize em \`row\` com \`col-md-*\`; agrupe secções com um \`card-title\` e um \`hr\`.
- Interruptores (\`form-check form-switch\`) para opções ligar/desligar; caixas de verificação (\`form-check\`) para listas.
- A mensagem de erro diz o que está mal e como corrigir.
- O rodapé do formulário (\`card-footer\`) tem "Cancelar" e a ação principal à direita.
`,
  },
  Alert: {
    group: 'Feedback', height: 200,
    html: `<div class="ds-pad d-flex flex-column gap-2" style="max-width:640px">
  <div class="alert alert-success mb-0">Contrato criado.</div>
  <div class="alert alert-warning mb-0">Por segurança, tem de definir uma nova password antes de continuar.</div>
  <div class="alert alert-danger mb-0">Código inválido. Confirme que a hora do telemóvel está certa e tente novamente.</div>
</div>`,
    readme: `# Alert

Avisos do Tabler (\`alert alert-<tipo>\`).

- \`alert-success\`: confirmação de uma ação (também como notificação no canto inferior direito, que desaparece em 3 s).
- \`alert-warning\`: algo que a pessoa tem de fazer antes de continuar.
- \`alert-danger\`: erro, com a causa e a forma de resolver.
- \`alert-info\`: informação de contexto que não pede ação.
- Uma frase curta, sem título e sem pontos de exclamação.
`,
  },
  PageHeader: {
    group: 'Estrutura', height: 140,
    html: `<div class="page-header m-0 ds-pad"><div class="row g-2 align-items-center">
  <div class="col">
    <ol class="breadcrumb breadcrumb-arrows mb-1"><li class="breadcrumb-item"><a href="#">Ativos</a></li><li class="breadcrumb-item"><a href="#">Acme Logística, S.A.</a></li></ol>
    <h2 class="page-title">SRV-ERP-SQL</h2>
    <div class="text-secondary mt-1">#5 · Máquina virtual · 10.10.1.22 · Sede Lisboa</div>
  </div>
  <div class="col-auto ms-auto"><div class="btn-list">
    <a href="#" class="btn btn-outline-danger">${icon('alert')}3 ativos afetados se falhar</a>
    <button class="btn btn-outline-danger">${icon('trash')}Eliminar</button>
    <button class="btn btn-primary">${icon('edit')}Editar</button>
  </div></div>
</div></div>`,
    readme: `# PageHeader

Cabeçalho de página do Tabler (\`page-header\`).

- Caminho em \`breadcrumb breadcrumb-arrows\`, título em \`page-title\`, uma linha de contexto em \`text-secondary\`.
- Ações à direita em \`btn-list\`; a ação primária em último lugar.
- Um aviso que exige atenção (ex.: ativos afetados) pode ser um botão \`btn-outline-danger\` que leva ao painel respetivo.
`,
  },
  Navigation: {
    group: 'Estrutura', height: 420,
    html: `<div class="ds-pad" data-bs-theme="dark"><aside class="navbar navbar-vertical ds-sidebar" data-bs-theme="dark"><div class="container-fluid flex-column align-items-stretch p-0">
  <div class="navbar-brand px-3 py-3"><span class="d-inline-flex align-items-center gap-2 text-white">${mark(28)}<span class="brand-word">rizoma</span></span></div>
  <ul class="navbar-nav">
    <li class="nav-item small text-uppercase text-secondary px-3 pt-2">Inventário</li>
    <li class="nav-item active"><a class="nav-link active" href="#"><span class="nav-link-icon">${icon('dashboard')}</span><span class="nav-link-title">Dashboard</span></a></li>
    <li class="nav-item"><a class="nav-link" href="#"><span class="nav-link-icon">${icon('assets')}</span><span class="nav-link-title">Ativos</span></a></li>
    <li class="nav-item"><a class="nav-link" href="#"><span class="nav-link-icon">${icon('clients')}</span><span class="nav-link-title">Clientes</span></a></li>
    <li class="nav-item"><a class="nav-link" href="#"><span class="nav-link-icon">${icon('contracts')}</span><span class="nav-link-title">Contratos</span></a></li>
    <li class="nav-item small text-uppercase text-secondary px-3 pt-3">Administração</li>
    <li class="nav-item"><a class="nav-link" href="#"><span class="nav-link-icon">${icon('users')}</span><span class="nav-link-title">Utilizadores</span></a></li>
    <li class="nav-item"><a class="nav-link" href="#"><span class="nav-link-icon">${icon('system')}</span><span class="nav-link-title">Sistema</span></a></li>
  </ul>
</div></aside></div>`,
    readme: `# Navigation

Barra lateral vertical do Tabler (\`navbar navbar-vertical\`), escura nos dois temas (\`data-bs-theme="dark"\`).

- No topo, o logótipo negativo; por baixo, a pesquisa global (Ctrl K).
- Grupos "Inventário" e "Administração", com títulos em maiúsculas pequenas.
- Cada item: \`nav-link\` com \`nav-link-icon\` (Tabler Icons) e \`nav-link-title\`. O item ativo usa \`active\`.
- No fundo, o utilizador (avatar com iniciais, nome, perfil), "Conta" e "Sair".
- Em ecrãs estreitos, o menu recolhe para o botão \`navbar-toggler\`.
`,
  },
};

for (const [name, c] of Object.entries(C)) {
  const dir = path.join(out, 'components', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), c.readme);
  fs.writeFileSync(path.join(dir, 'preview.html'), `<!-- @dsCard group="${c.group}" height=${c.height} -->
<!doctype html>
<html lang="pt-PT">
<head><meta charset="utf-8"><title>${name} — Rizoma</title></head>
<body>
${c.html}
</body>
</html>
`);
}
console.log('bundle.css', fs.statSync(path.join(out, 'components', 'bundle.css')).size, 'bytes; componentes:', Object.keys(C).join(', '));
