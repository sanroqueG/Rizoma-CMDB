/* Ecrã de login (password, 2FA) e página "A minha conta". Layout: página de autenticação do Tabler. */
import { AUTH, GET, L, ME, api, badge, brandLogo, card, field, h, openDialog, setME, setMETA, setShell, toast } from './core.js';
import { pageHead, render, setPage } from './main.js';

// ======================================================================= login
export async function afterLogin(me) {
  setME(me);
  setMETA(await GET('/api/meta'));
  if (me.recovery_codes_left !== undefined && me.recovery_codes_left <= 3) {
    toast(`Restam ${me.recovery_codes_left} códigos de recuperação. Gere novos em "A minha conta".`, true);
  }
  render();
}

export function renderLogin(message) {
  setShell(null);
  const body = h('div', { class: 'card-body' });
  document.getElementById('app').replaceChildren(h('div', { class: 'page page-center' },
    h('div', { class: 'container container-tight py-4' },
      h('div', { class: 'text-center mb-4' }, h('a', { href: '#/', class: 'navbar-brand navbar-brand-autodark' }, brandLogo(40))),
      h('div', { class: 'card card-md' }, body),
      h('div', { class: 'text-center text-secondary mt-3 small' },
        `${location.host} · ${AUTH.oidc ? `SSO ${AUTH.oidc.label} ou conta local` : 'conta local'}${AUTH.require_2fa ? ' · 2FA obrigatório' : ''}`))));

  function passwordStep(msg) {
    const err = h('div', { class: 'alert alert-danger error', hidden: !msg }, msg || '');
    const btn = h('button', { class: AUTH.oidc ? 'w-100' : 'primary w-100', type: 'submit' }, 'Entrar');
    const form = h('form', {
      autocomplete: 'on',
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        err.hidden = true;
        try {
          const fd = new FormData(form);
          const r = await api('POST', '/api/login', { username: fd.get('username'), password: fd.get('password') });
          if (r.mfa_required) return mfaStep(r.mfa_token);
          await afterLogin(r);
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
        } finally {
          btn.disabled = false;
        }
      },
    },
    h('h2', { class: 'h2 text-center mb-4' }, 'Iniciar sessão'), err,
    AUTH.oidc ? h('a', { class: 'btn btn-primary w-100', href: '/api/auth/oidc/start' }, `Entrar com ${AUTH.oidc.label}`) : null,
    AUTH.oidc ? h('div', { class: 'hr-text' }, 'ou') : null,
    field('Utilizador', h('input', { name: 'username', autocomplete: 'username', required: true, autofocus: true })),
    field('Password', h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
    h('div', { class: 'form-footer' }, btn),
    AUTH.signup ? h('div', { class: 'text-center text-secondary mt-3' }, 'Ainda não tem conta? ',
      h('button', { type: 'button', class: 'link', onclick: () => signupStep() }, 'Criar conta para a sua empresa')) : null);
    body.replaceChildren(form);
    form.querySelector('input').focus();
  }

  function signupStep() {
    const err = h('div', { class: 'alert alert-danger error', hidden: true });
    const btn = h('button', { class: 'primary w-100', type: 'submit' }, 'Criar conta');
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        err.hidden = true;
        try {
          const fd = new FormData(form);
          await afterLogin(await api('POST', '/api/signup', Object.fromEntries(fd)));
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
        } finally {
          btn.disabled = false;
        }
      },
    },
    h('h2', { class: 'h2 text-center mb-2' }, 'Criar conta'),
    h('p', { class: 'text-secondary text-center mb-4' }, 'Cria a organização da sua empresa e o primeiro administrador.'),
    err,
    field('Empresa', h('input', { name: 'organization', required: true, autocomplete: 'organization', placeholder: 'ex.: Acme Serviços de TI, Lda.' })),
    field('O seu nome', h('input', { name: 'name', required: true, autocomplete: 'name' })),
    field('Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' })),
    field('Utilizador', h('input', { name: 'username', required: true, autocomplete: 'username' })),
    h('div', { class: 'mb-3' }, h('label', { class: 'form-label' }, 'Password'),
      h('input', { name: 'password', type: 'password', required: true, minlength: 10, autocomplete: 'new-password' }),
      h('div', { class: 'form-hint' }, 'Mínimo de 10 caracteres, com pelo menos dois tipos (minúsculas, maiúsculas, números ou símbolos).')),
    h('div', { class: 'form-footer' }, btn),
    h('div', { class: 'text-center mt-3' }, h('button', { type: 'button', class: 'link', onclick: () => passwordStep() }, 'Já tenho conta')));
    body.replaceChildren(form);
    form.querySelector('input').focus();
  }

  function mfaStep(token) {
    const err = h('div', { class: 'alert alert-danger error', hidden: true });
    const code = h('input', { name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', required: true, maxlength: 11, placeholder: '123456', class: 'text-center' });
    const btn = h('button', { class: 'primary w-100', type: 'submit' }, 'Verificar');
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        err.hidden = true;
        try {
          await afterLogin(await api('POST', '/api/login/mfa', { mfa_token: token, code: code.value }));
        } catch (ex) {
          if (/expirou|tentativas/.test(ex.message)) return passwordStep(ex.message);
          err.textContent = ex.message;
          err.hidden = false;
          code.select();
        } finally {
          btn.disabled = false;
        }
      },
    },
    h('h2', { class: 'h2 text-center mb-2' }, 'Verificação em dois passos'),
    h('p', { class: 'text-secondary text-center mb-4' }, 'Introduza o código de 6 dígitos da sua app de autenticação, ou um código de recuperação.'),
    err, field('Código', code), h('div', { class: 'form-footer' }, btn),
    h('div', { class: 'text-center mt-3' }, h('button', { type: 'button', class: 'link', onclick: () => passwordStep() }, 'Voltar')));
    body.replaceChildren(form);
    code.focus();
  }

  passwordStep(message);
}

// ======================================================================= conta
export function twoFactorCard() {
  const body = h('div', { class: 'card-body' });
  const el = h('div', { class: 'card' }, h('div', { class: 'card-header' }, h('h2', { class: 'card-title' }, 'Autenticação de dois fatores')), body);
  function draw() {
    if (ME.totp_enabled) {
      body.replaceChildren(
        h('p', {}, badge('Ativa', 'ok'), ' O login com password pede também um código da app de autenticação.'),
        h('div', { class: 'btn-list' },
          h('button', { onclick: newCodes }, 'Gerar novos códigos de recuperação'),
          AUTH.require_2fa ? null : h('button', { class: 'danger', onclick: disable }, 'Desativar')));
    } else {
      body.replaceChildren(
        ME.mfa_setup_required ? h('div', { class: 'alert alert-warning' }, 'Esta instalação exige autenticação de dois fatores. Configure-a para continuar.') : null,
        h('p', { class: 'text-secondary' }, 'Proteja a conta com um código temporário gerado no telemóvel (Microsoft Authenticator, Google Authenticator, Authy, 1Password…).'),
        h('button', { class: 'primary', onclick: setup }, 'Configurar'));
    }
  }
  async function setup() {
    const s = await api('POST', '/api/me/2fa/setup');
    const code = h('input', { name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', required: true, maxlength: 6, placeholder: '123456' });
    const err = h('div', { class: 'alert alert-danger error', hidden: true });
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        err.hidden = true;
        try {
          const r = await api('POST', '/api/me/2fa/enable', { code: code.value });
          const wasForced = ME.mfa_setup_required;
          ME.totp_enabled = true;
          ME.mfa_setup_required = false;
          showCodes(r.recovery_codes, wasForced);
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
        }
      },
    },
    h('p', {}, '1. Leia o código QR com a app de autenticação:'),
    h('div', { class: 'qr mb-3' }, QR.toSvg(s.uri, 200)),
    h('p', { class: 'text-secondary small' }, 'Não consegue ler o código? Introduza esta chave manualmente: ',
      h('code', {}, s.secret.replace(/(.{4})/g, '$1 ').trim())),
    err, field('2. Código de 6 dígitos que aparece na app', code),
    h('div', { class: 'btn-list' }, h('button', { class: 'primary', type: 'submit' }, 'Ativar'), h('button', { type: 'button', onclick: draw }, 'Cancelar')));
    body.replaceChildren(form);
    code.focus();
  }
  function showCodes(codes, goHome) {
    body.replaceChildren(
      h('h3', { class: 'card-title' }, 'Códigos de recuperação'),
      h('p', {}, 'Guarde estes códigos num local seguro. Cada um permite entrar ', h('strong', {}, 'uma única vez'), ' se perder o telemóvel. Não voltam a ser mostrados.'),
      h('div', { class: 'codes font-monospace' }, codes.map((c) => h('span', {}, c))),
      h('div', { class: 'btn-list' },
        h('button', { onclick: () => navigator.clipboard.writeText(codes.join('\n')).then(() => toast('Códigos copiados.'), () => toast('Não foi possível copiar.', true)) }, 'Copiar'),
        h('button', { class: 'primary', onclick: () => { draw(); if (goHome) location.hash = '#/'; } }, 'Já guardei os códigos')));
  }
  function newCodes() {
    openDialog('Novos códigos de recuperação', [
      h('p', { class: 'text-secondary' }, 'Os códigos atuais deixam de funcionar.'),
      field('Código da app de autenticação', h('input', { name: 'code', inputmode: 'numeric', required: true, maxlength: 6, autocomplete: 'one-time-code' }))],
    async (fd) => {
      const r = await api('POST', '/api/me/2fa/recovery-codes', { code: fd.get('code') });
      showCodes(r.recovery_codes, false);
    }, { submitLabel: 'Gerar' });
  }
  function disable() {
    openDialog('Desativar 2FA', field('Confirme com a sua password', h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
      async (fd) => {
        await api('POST', '/api/me/2fa/disable', { password: fd.get('password') });
        ME.totp_enabled = false;
        toast('Autenticação de dois fatores desativada.');
        draw();
      }, { submitLabel: 'Desativar', danger: true });
  }
  draw();
  return el;
}

export function passwordCard(forced) {
  const err = h('div', { class: 'alert alert-danger error', hidden: true });
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    err.hidden = true;
    const fd = new FormData(form);
    if (fd.get('password') !== fd.get('confirm')) { err.textContent = 'As passwords não coincidem.'; err.hidden = false; return; }
    try {
      await api('POST', '/api/me/password', { current: fd.get('current'), password: fd.get('password') });
      form.reset();
      toast('Password alterada.');
      if (ME.password_change_required) {
        ME.password_change_required = false;
        ME.must_change_password = false;
        if (ME.mfa_setup_required) render(); else location.hash = '#/';
      }
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  } },
  err,
  field('Password atual', h('input', { name: 'current', type: 'password', required: true, autocomplete: 'current-password' })),
  field('Nova password', h('input', { name: 'password', type: 'password', required: true, minlength: 10, autocomplete: 'new-password' })),
  field('Confirmar nova password', h('input', { name: 'confirm', type: 'password', required: true, minlength: 10, autocomplete: 'new-password' })),
  h('p', { class: 'form-hint mb-3' }, 'Mínimo de 10 caracteres, com pelo menos dois tipos (minúsculas, maiúsculas, números ou símbolos). Passwords comuns são recusadas.'),
  h('button', { class: 'primary', type: 'submit' }, forced ? 'Definir password' : 'Alterar password'));
  return card(forced ? 'Definir nova password' : 'Alterar password', form);
}

export async function viewAccount() {
  const forced = ME.password_change_required;
  setPage(pageHead('A minha conta', `${ME.username} · ${L.role[ME.role]}`),
    forced ? h('div', { class: 'alert alert-warning' }, 'Por segurança, tem de definir uma nova password antes de continuar.') : null,
    h('div', { class: 'row row-cards' },
      h('div', { class: 'col-lg-6' }, passwordCard(forced)),
      forced ? null : h('div', { class: 'col-lg-6 d-flex flex-column gap-3' }, twoFactorCard(), ME.role === 'client' ? null : digestCard())));
}

/** Preferência do resumo semanal por email, com pré-visualização do conteúdo atual. */
export function digestCard() {
  const box = h('input', { type: 'checkbox', checked: ME.notify_digest, onchange: async (e) => {
    try {
      const r = await api('PUT', '/api/me/notifications', { digest: e.target.checked });
      ME.notify_digest = r.digest;
      toast(r.digest ? 'Vai receber o resumo semanal.' : 'Resumo semanal desligado.');
    } catch (ex) { e.target.checked = !e.target.checked; toast(ex.message, true); }
  } });
  const preview = h('pre', { class: 'mt-3 mb-0', hidden: true });
  return card('Resumo semanal por email', [
    h('p', { class: 'text-secondary' }, 'Uma vez por semana: garantias e contratos a expirar, agentes sem contacto e conectores com erros, só dos seus clientes. ',
      ME.email ? `Enviado para ${ME.email}.` : 'Peça a um administrador que registe o seu email.'),
    h('label', { class: 'form-check form-switch' }, box, h('span', { class: 'form-check-label' }, 'Receber o resumo semanal')),
    h('button', { class: 'mt-2', onclick: async () => {
      const d = await GET('/api/me/digest');
      preview.textContent = d.total ? d.preview : 'Neste momento não há nada a reportar. Resumos vazios não são enviados.';
      preview.hidden = false;
    } }, 'Pré-visualizar'),
    preview]);
}
