'use strict';
/*
 * Planos comerciais. Os limites aplicam-se à organização quando a subscrição muda;
 * o preço vive no Stripe (CMDB_STRIPE_PRICES associa cada plano ao seu price id).
 * null = sem limite.
 */
const PLANS = {
  essencial: { label: 'Essencial', limits: { max_clients: 10, max_cis: 1000, max_users: 3 } },
  profissional: { label: 'Profissional', limits: { max_clients: 50, max_cis: 10000, max_users: 15 } },
  empresa: { label: 'Empresa', limits: { max_clients: null, max_cis: null, max_users: null } },
};
// Limites durante o período experimental (iguais ao plano Profissional, para o cliente experimentar tudo)
const TRIAL_LIMITS = PLANS.profissional.limits;

/** Estados do Stripe em que a organização pode trabalhar normalmente. */
const GOOD_STANDING = new Set(['trialing', 'active', 'past_due']);

module.exports = { PLANS, TRIAL_LIMITS, GOOD_STANDING };
