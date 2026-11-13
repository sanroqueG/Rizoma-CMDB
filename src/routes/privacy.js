'use strict';
/*
 * RGPD: pedido de eliminação de todos os dados da organização (direito ao apagamento, art. 17.º)
 * e aceitação dos termos no registo.
 * O pedido deixa a organização só de leitura durante DELETION_GRACE_DAYS (pode exportar e desistir);
 * depois, purgeDeletedOrgs() apaga a organização e tudo o que lhe pertence (chaves estrangeiras em cascata).
 */
const { fail } = require('../http');
const S = require('../schema');

const DELETION_GRACE_DAYS = 30;

module.exports = function registerPrivacy(core) {
  const { add, one, all, run, audit, assertAdmin, opts, log } = core;
  const env = process.env;
  core.legal = {
    termsUrl: opts.termsUrl ?? env.CMDB_TERMS_URL ?? null,
    privacyUrl: opts.privacyUrl ?? env.CMDB_PRIVACY_URL ?? null,
    version: opts.termsVersion ?? env.CMDB_TERMS_VERSION ?? null,
  };
  const graceMs = (opts.deletionGraceDays ?? DELETION_GRACE_DAYS) * 864e5;
  core.deletionDate = (requestedAt) => new Date(new Date(requestedAt).getTime() + graceMs).toISOString();

  add('GET', '/api/org/deletion', ({ user }) => {
    assertAdmin(user);
    const o = one('SELECT deletion_requested_at, deletion_requested_by FROM organizations WHERE id = ?', user.org_id);
    return o.deletion_requested_at
      ? { requested: true, requested_at: o.deletion_requested_at, requested_by: o.deletion_requested_by, delete_at: core.deletionDate(o.deletion_requested_at) }
      : { requested: false, grace_days: graceMs / 864e5 };
  }, { billingExempt: true });

  add('POST', '/api/org/deletion', async ({ user, body }) => {
    assertAdmin(user);
    const o = one('SELECT * FROM organizations WHERE id = ?', user.org_id);
    if (o.id === 1 || user.is_platform) fail(400, 'A organização da plataforma não pode ser eliminada por aqui');
    if (String(body.confirm || '').trim().toLowerCase() !== o.slug.toLowerCase()) fail(400, `Para confirmar, escreva o identificador da organização: ${o.slug}`);
    if (o.deletion_requested_at) fail(409, 'A eliminação já foi pedida');
    const now = new Date().toISOString();
    run('UPDATE organizations SET deletion_requested_at = ?, deletion_requested_by = ? WHERE id = ?', now, user.username, o.id);
    // Sem dados, sem cobrança: cancela a subscrição no fim do período já pago
    if (o.stripe_subscription_id && core.cancelSubscriptionAtPeriodEnd) {
      try { await core.cancelSubscriptionAtPeriodEnd(o.stripe_subscription_id); } catch (e) { log.error('Cancelar a subscrição falhou', { org: o.id, err: e }); }
    }
    audit('organization', o.id, null, o.name, user.username, 'eliminacao_pedida', { eliminar_em: core.deletionDate(now) }, o.id);
    return { requested: true, requested_at: now, delete_at: core.deletionDate(now) };
  }, { billingExempt: true, body: S.obj({ confirm: S.str({ max: 120, required: true, label: 'Confirmação' }) }) });

  add('DELETE', '/api/org/deletion', ({ user }) => {
    assertAdmin(user);
    const o = one('SELECT * FROM organizations WHERE id = ?', user.org_id);
    if (!o.deletion_requested_at) fail(400, 'Não há nenhum pedido de eliminação');
    run('UPDATE organizations SET deletion_requested_at = NULL, deletion_requested_by = NULL WHERE id = ?', o.id);
    audit('organization', o.id, null, o.name, user.username, 'eliminacao_cancelada', null, o.id);
    return { requested: false };
  }, { billingExempt: true });

  /** Apaga as organizações cujo prazo terminou. Devolve o número de organizações eliminadas. */
  core.purgeDeletedOrgs = (now = new Date()) => {
    const due = all('SELECT id, name, slug, deletion_requested_at FROM organizations WHERE deletion_requested_at IS NOT NULL AND id <> 1')
      .filter((o) => core.deletionDate(o.deletion_requested_at) <= now.toISOString());
    for (const o of due) {
      run('DELETE FROM organizations WHERE id = ?', o.id);
      // Registo mínimo na auditoria da plataforma (sem dados da organização além do nome)
      audit('organization', o.id, null, o.name, 'sistema', 'eliminada', { pedido_em: o.deletion_requested_at }, 1);
      if (log.info) log.info('Organização eliminada a pedido (RGPD)', { org: o.id, slug: o.slug });
    }
    return due.length;
  };
};
