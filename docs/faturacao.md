# Subscrições e faturação

O Rizoma cobra as subscrições pelo **Stripe** (Checkout e portal do cliente). Configuração em `.env.example`
(`CMDB_STRIPE_*`). Sem `CMDB_STRIPE_SECRET_KEY`, os pagamentos ficam desligados.

## Configurar o Stripe

1. Crie um produto por plano (`essencial`, `profissional`, `empresa`) com um preço recorrente (mensal ou anual).
   Os limites de cada plano estão em `src/plans.js`; o preço vive só no Stripe.
2. Ponha os price ids em `CMDB_STRIPE_PRICES`. Um plano sem price id aparece com "Falar com a equipa".
3. Crie um endpoint de webhook para `https://<CMDB_PUBLIC_URL>/api/stripe/webhook` com os eventos
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted` e `invoice.payment_failed`. Ponha o segredo (`whsec_…`) em `CMDB_STRIPE_WEBHOOK_SECRET`.
4. Ative o **portal do cliente** no Stripe (mudar de plano, cancelar, meio de pagamento, faturas).
5. Teste em modo de teste: `stripe listen --forward-to localhost:3000/api/stripe/webhook`.

## Regras

- Organizações registadas começam um período experimental (`CMDB_TRIAL_DAYS`, 14 por omissão) com os limites do plano Profissional.
- Terminado o período sem subscrição, ou com a subscrição cancelada, a organização fica **só de leitura**:
  consulta, exporta os dados e escolhe um plano, mas não altera nada. Um pagamento falhado (`past_due`) não bloqueia:
  o Stripe tenta de novo e o Rizoma mostra um aviso.
- Organizações sem estado de faturação (as anteriores e as criadas pela plataforma) não são afetadas.
- Os webhooks são verificados pela assinatura (tolerância de 5 minutos) e processados uma só vez (tabela `stripe_events`).

## Faturas em Portugal

As faturas a clientes portugueses têm de ser emitidas por **software certificado pela AT** (comunicação à AT, ATCUD, QR code).
As faturas do Stripe não cumprem isto. Opções:

- ligar o Stripe a um programa certificado (InvoiceXpress, Moloni, Vendus, entre outros têm integração com o Stripe
  ou importação dos pagamentos), que emite a fatura-recibo em cada pagamento; ou
- emitir as faturas no programa de faturação da empresa, a partir dos relatórios de pagamentos do Stripe.

Em ambos os casos, desligue o envio de faturas do Stripe aos clientes portugueses, para não circularem dois documentos.
Confirme a solução com o contabilista certificado.
