'use strict';
/* Emails transacionais do Rizoma (texto + HTML simples, com as cores da marca). */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Envolve o conteúdo no modelo da marca. paragraphs: textos; action: { label, url }. */
function layout({ greeting, paragraphs, action, footer }) {
  const text = [greeting, '', ...paragraphs.flatMap((p) => [p, '']), action ? `${action.label}: ${action.url}` : null, '',
    footer || 'Se não foi você a pedir isto, ignore este email.'].filter((x) => x !== null).join('\n');
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1f2937;max-width:560px">
  <div style="border-top:3px solid #0f6b73;padding-top:12px;margin-bottom:20px;font-weight:700;font-size:18px;color:#0f6b73">rizoma</div>
  <p>${esc(greeting)}</p>
  ${paragraphs.map((p) => `<p style="line-height:1.5">${esc(p)}</p>`).join('\n  ')}
  ${action ? `<p style="margin:24px 0"><a href="${esc(action.url)}" style="background:#0f6b73;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">${esc(action.label)}</a></p>
  <p style="font-size:12px;color:#6b7280">Se o botão não funcionar, copie esta ligação para o browser:<br>${esc(action.url)}</p>` : ''}
  <p style="font-size:12px;color:#6b7280;margin-top:24px">${esc(footer || 'Se não foi você a pedir isto, ignore este email.')}</p>
</div>`;
  return { text, html };
}

function resetEmail({ name, url, minutes }) {
  return {
    subject: 'Rizoma: redefinir a password',
    ...layout({
      greeting: `Olá ${name},`,
      paragraphs: [`Recebemos um pedido para redefinir a sua password. A ligação é válida durante ${minutes} minutos e só pode ser usada uma vez.`],
      action: { label: 'Definir nova password', url },
      footer: 'Se não pediu para redefinir a password, ignore este email: a password atual continua válida.',
    }),
  };
}

function inviteEmail({ name, orgName, inviter, url, days }) {
  return {
    subject: `Rizoma: convite para ${orgName}`,
    ...layout({
      greeting: `Olá ${name},`,
      paragraphs: [`${inviter} convidou-o para a organização ${orgName} no Rizoma, a CMDB onde a equipa gere o inventário dos clientes.`,
        `Defina a sua password para entrar. O convite é válido durante ${days} dias.`],
      action: { label: 'Aceitar o convite', url },
      footer: 'Se não esperava este convite, ignore este email.',
    }),
  };
}

function verifyEmail({ name, url, hours }) {
  return {
    subject: 'Rizoma: confirme o seu email',
    ...layout({
      greeting: `Olá ${name},`,
      paragraphs: [`Confirme que este é o seu endereço de email. A ligação é válida durante ${hours} horas.`],
      action: { label: 'Confirmar email', url },
      footer: 'Se não criou uma conta no Rizoma, ignore este email.',
    }),
  };
}

module.exports = { layout, resetEmail, inviteEmail, verifyEmail, esc };
