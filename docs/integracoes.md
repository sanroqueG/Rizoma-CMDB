# Integrações RMM

## NinjaOne

Importa os dispositivos geridos no NinjaOne para os clientes do Rizoma. Uma ligação por organização do Rizoma;
cada organização do NinjaOne é associada a um cliente.

1. No NinjaOne: **Administração → Apps → API → Client app IDs → Adicionar**, tipo
   "API Services (machine-to-machine)", âmbito **Monitoring**, concessão **Client Credentials**. Guarde o Client ID e o secret.
2. No Rizoma: **Integrações → Ligar ao NinjaOne**, com a região da conta (Europa: `eu.ninjarmm.com`).
   A ligação é testada logo e a lista de organizações do NinjaOne aparece, com o cliente sugerido pelo nome.
3. Confirme as associações e **Sincronizar agora**. Depois, sincroniza uma vez por dia (`CMDB_SYNC_HOURS`).

Regras:

- Só leitura: o Rizoma nunca altera nada no NinjaOne. O secret fica encriptado na BD.
- Um dispositivo que já existe (vindo do agente, do Intune ou criado à mão) é reconhecido pelo id do NinjaOne,
  pelo número de série ou pelo hostname, e é atualizado em vez de duplicado.
- Dispositivos que deixam de existir no NinjaOne passam a "abatido" (não são apagados).
- Organizações sem cliente associado são ignoradas e contadas no relatório da sincronização.
- Tipo de ativo pelo `nodeClass`: servidores, máquinas virtuais, equipamentos de rede, firewalls e impressoras (NMS),
  telemóveis (MDM); o resto é posto de trabalho ou portátil.

> O mapeamento dos campos segue a documentação pública da API v2 do NinjaOne e foi testado contra um simulador.
> Valide com uma conta real antes de anunciar a integração a clientes.

## Avisos e webhooks

Em **Integrações → Avisos e webhooks**, cada organização liga destinos:

| Tipo | Como obter o URL | O que recebe |
|---|---|---|
| Slack | Apps → Incoming Webhooks → Add to Slack → canal | Mensagem curta; várias alterações seguidas numa só |
| Microsoft Teams | No canal: … → Workflows → "Post to a channel when a webhook request is received" | Adaptive Card; várias alterações numa só |
| Webhook | Qualquer URL https | Um POST JSON por evento, assinado |

Eventos: ativo criado, alterado, eliminado ou com mudança de estado; contrato criado, alterado, eliminado ou a expirar
(30 e 7 dias antes); ticket criado ou alterado; cliente criado ou eliminado; sincronização falhada; novas
vulnerabilidades. Por omissão, o Slack e o Teams só recebem o que pede atenção (mudanças de estado, eliminações,
contratos a expirar, falhas, vulnerabilidades), para não inundar o canal. Um destino pode ficar limitado a um cliente.

Garantias:

- Os eventos entram numa fila na mesma transação da alteração: uma alteração desfeita não gera aviso.
- Envio a cada 15 s; em caso de erro, novas tentativas após 1 min, 5 min, 30 min, 2 h e 6 h. Após 50 falhas
  seguidas, o destino é desligado (o administrador volta a ligá-lo).
- Os URLs ficam encriptados e nunca são mostrados por inteiro. Destinos que resolvem para endereços internos são recusados.

### Verificar a assinatura (webhooks genéricos)

Cabeçalhos: `X-Rizoma-Event`, `X-Rizoma-Delivery` (id único, para ignorar repetições) e
`X-Rizoma-Signature: t=<segundos>,v1=<hex>`, em que `v1 = HMAC-SHA256(segredo, "<t>.<corpo>")`.
O segredo (`whsec_…`) é mostrado uma só vez, ao criar o destino.

```js
const [t, v1] = req.headers['x-rizoma-signature'].split(',').map((x) => x.split('=')[1]);
const ok = crypto.timingSafeEqual(Buffer.from(v1),
  Buffer.from(crypto.createHmac('sha256', segredo).update(`${t}.${corpoOriginal}`).digest('hex')));
// e rejeite se Math.abs(Date.now() / 1000 - t) > 300
```

## Inventário de software e vulnerabilidades (CVE)

- O agente Windows (`agent/inventario.ps1`) envia os programas instalados (registo do Windows, 64 e 32 bits),
  em `software` no `POST /api/v1/ingest`. Cada envio substitui a lista anterior do ativo.
- Os programas reconhecidos pelo catálogo (`src/cve/catalog.js`: navegadores, 7-Zip, WinRAR, Notepad++, VLC,
  PuTTY, WinSCP, FileZilla, Wireshark, KeePass, TeamViewer, AnyDesk, Git, Python, Node.js, LibreOffice,
  leitores de PDF, VMware, Citrix, PostgreSQL, OpenVPN…) são cruzados com a NVD (NIST) pela versão instalada.
- As vulnerabilidades já exploradas por atacantes (catálogo KEV da CISA) aparecem primeiro.
- Atualização de hora a hora, com cache de 24 h por produto. Defina `CMDB_NVD_API_KEY` (gratuita) para ser
  ~10x mais rápida. Novidades geram o aviso "Novas vulnerabilidades" (um por cliente).
- Critério conservador: um CVE sem versões indicadas na NVD não é atribuído; uma vulnerabilidade que só afeta o
  produto num sistema operativo específico pode aparecer noutros (a NVD descreve-o em condições combinadas que
  não são avaliadas).

**Não abrangido ainda:** pacotes de distribuições Linux (as distribuições corrigem sem mudar a versão principal,
o que daria falsos alarmes; a solução prevista é a base OSV) e aplicações macOS.
