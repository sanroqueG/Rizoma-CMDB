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
