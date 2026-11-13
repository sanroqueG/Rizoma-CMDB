'use strict';
/* Login único (SSO) via OpenID Connect — Authorization Code + PKCE.
   Funciona com Microsoft Entra ID, Google Workspace, Keycloak, Authentik, Okta, etc. */
const crypto = require('node:crypto');

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const rnd = (n) => b64url(crypto.randomBytes(n));

function createOidc({ issuer, clientId, clientSecret, redirectUri, label, fetchFn = globalThis.fetch }) {
  const base = issuer.replace(/\/+$/, '');
  const pending = new Map(); // state → { nonce, verifier, exp }
  let discovery = null;
  let discoveryAt = 0;
  let jwks = null;
  let jwksAt = 0;

  async function discover() {
    if (discovery && Date.now() - discoveryAt < 3600e3) return discovery;
    const r = await fetchFn(`${base}/.well-known/openid-configuration`);
    if (!r.ok) throw new Error(`Não foi possível obter a configuração OIDC (${r.status})`);
    discovery = await r.json();
    discoveryAt = Date.now();
    return discovery;
  }

  async function start() {
    const d = await discover();
    const now = Date.now();
    for (const [k, v] of pending) if (v.exp < now) pending.delete(k);
    const state = rnd(24);
    const nonce = rnd(24);
    const verifier = rnd(32);
    pending.set(state, { nonce, verifier, exp: now + 10 * 60e3 });
    const u = new URL(d.authorization_endpoint);
    u.search = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: 'openid profile email',
      state, nonce, code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
    }).toString();
    return { url: u.toString(), state };
  }

  async function signingKey(kid, refresh) {
    const d = await discover();
    if (!jwks || refresh || Date.now() - jwksAt > 3600e3) {
      const r = await fetchFn(d.jwks_uri);
      if (!r.ok) throw new Error('Não foi possível obter as chaves do fornecedor de identidade');
      jwks = await r.json();
      jwksAt = Date.now();
    }
    const keys = jwks.keys || [];
    return keys.find((k) => k.kid === kid) || (!kid && keys.length === 1 ? keys[0] : null);
  }

  async function verifyIdToken(jwt, nonce) {
    const parts = String(jwt || '').split('.');
    if (parts.length !== 3) throw new Error('id_token inválido');
    const [h, p, s] = parts;
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    if (!['RS256', 'PS256', 'ES256'].includes(header.alg)) throw new Error(`Algoritmo não suportado: ${header.alg}`);
    let jwk = await signingKey(header.kid);
    if (!jwk) jwk = await signingKey(header.kid, true); // rotação de chaves
    if (!jwk) throw new Error('Chave de assinatura desconhecida');
    const key = crypto.createPublicKey({
      key: jwk.kty === 'EC' ? { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } : { kty: jwk.kty, n: jwk.n, e: jwk.e },
      format: 'jwk',
    });
    const data = Buffer.from(`${h}.${p}`);
    const sig = Buffer.from(s, 'base64url');
    let ok;
    if (header.alg === 'RS256') ok = crypto.verify('sha256', data, key, sig);
    else if (header.alg === 'PS256') ok = crypto.verify('sha256', data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, sig);
    else ok = crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
    if (!ok) throw new Error('Assinatura do id_token inválida');

    const c = JSON.parse(Buffer.from(p, 'base64url').toString());
    const d = await discover();
    const now = Math.floor(Date.now() / 1000);
    if (c.iss !== d.issuer) throw new Error('Emissor (iss) inválido');
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (!aud.includes(clientId)) throw new Error('Audiência (aud) inválida');
    if (!c.exp || c.exp < now - 60) throw new Error('id_token expirado');
    if (c.nbf && c.nbf > now + 60) throw new Error('id_token ainda não é válido');
    if (c.nonce !== nonce) throw new Error('nonce inválido');
    return c;
  }

  async function finish(code, state) {
    const p = pending.get(state);
    pending.delete(state);
    if (!p || p.exp < Date.now()) throw new Error('O pedido de login expirou. Tente novamente.');
    const d = await discover();
    const r = await fetchFn(d.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: String(code || ''), redirect_uri: redirectUri,
        client_id: clientId, client_secret: clientSecret, code_verifier: p.verifier,
      }).toString(),
    });
    if (!r.ok) throw new Error(`O fornecedor de identidade recusou o código (${r.status})`);
    const tok = await r.json();
    const claims = await verifyIdToken(tok.id_token, p.nonce);
    const identities = [claims.email, claims.preferred_username, claims.upn, claims.unique_name]
      .filter(Boolean).map((x) => String(x).toLowerCase());
    return { claims, identities };
  }

  return { label: label || 'SSO', start, finish };
}

module.exports = { createOidc };
