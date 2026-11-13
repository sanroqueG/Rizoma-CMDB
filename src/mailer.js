'use strict';
/*
 * Cliente SMTP mínimo (sem dependências): EHLO, STARTTLS ou TLS direto (porta 465), AUTH PLAIN/LOGIN,
 * mensagens multipart (texto + HTML) em UTF-8.
 */
const net = require('node:net');
const tls = require('node:tls');
const os = require('node:os');
const crypto = require('node:crypto');

/** Configuração a partir das variáveis de ambiente; null se o SMTP não estiver configurado. */
function smtpConfigFromEnv(env = process.env) {
  if (!env.CMDB_SMTP_HOST) return null;
  const secure = env.CMDB_SMTP_SECURE === '1' || env.CMDB_SMTP_PORT === '465';
  return {
    host: env.CMDB_SMTP_HOST,
    port: Number(env.CMDB_SMTP_PORT) || (secure ? 465 : 587),
    secure,
    user: env.CMDB_SMTP_USER || null,
    pass: env.CMDB_SMTP_PASS || null,
    from: env.CMDB_SMTP_FROM || env.CMDB_SMTP_USER || `cmdb@${os.hostname()}`,
    // Só para servidores internos com certificado próprio
    rejectUnauthorized: env.CMDB_SMTP_INSECURE !== '1',
  };
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const wrap76 = (s) => s.replace(/.{1,76}/g, '$&\r\n').trimEnd();
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const addrOnly = (a) => { const m = /<([^>]+)>/.exec(a); return (m ? m[1] : a).trim(); };
function cleanAddress(a) {
  const s = String(a || '').trim();
  if (/[\r\n]/.test(s) || !/^[^@\s<>]+@[^@\s<>]+$/.test(addrOnly(s))) throw new Error(`Endereço de email inválido: ${s}`);
  return s;
}

/** Constrói a mensagem MIME (cabeçalhos + corpo), com quebras de linha CRLF. */
function buildMessage({ from, to, subject, text, html }) {
  const boundary = `=_cmdb_${crypto.randomBytes(12).toString('hex')}`;
  const domain = addrOnly(from).split('@')[1] || 'cmdb.local';
  const headers = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
  ];
  const parts = [];
  if (text) parts.push(['text/plain', text]);
  if (html) parts.push(['text/html', html]);
  const body = [
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    ...parts.flatMap(([type, content]) => [
      `--${boundary}`, `Content-Type: ${type}; charset=utf-8`, 'Content-Transfer-Encoding: base64', '', wrap76(b64(content)),
    ]),
    `--${boundary}--`, '',
  ];
  return [...headers, ...body].join('\r\n');
}

/**
 * @param {any} cfg
 * @param {{ connect?: (cfg: any) => any }} [o]
 */
function createMailer(cfg, { connect } = {}) {
  if (!cfg || !cfg.host) return null;
  const timeoutMs = cfg.timeoutMs || 20000;

  async function send({ to, subject, text, html }) {
    const recipients = (Array.isArray(to) ? to : [to]).map(cleanAddress);
    if (!recipients.length) throw new Error('Sem destinatários');
    const from = cleanAddress(cfg.from);
    const message = buildMessage({ from, to: recipients, subject: String(subject).replace(/[\r\n]+/g, ' '), text, html });

    let socket = connect
      ? connect(cfg)
      : cfg.secure
        ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host, rejectUnauthorized: cfg.rejectUnauthorized !== false })
        : net.connect({ host: cfg.host, port: cfg.port });

    // Leitor de respostas SMTP (suporta respostas de várias linhas "250-...")
    let buf = '';
    let waiting = null;
    let failure = null;
    const lines = [];
    const onData = (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
      pump();
    };
    function pump() {
      if (!waiting) return;
      if (failure) { const w = waiting; waiting = null; w.reject(failure); return; }
      const end = lines.findIndex((l) => /^\d{3}(?: |$)/.test(l));
      if (end < 0) return;
      const block = lines.splice(0, end + 1);
      const w = waiting;
      waiting = null;
      w.resolve({ code: Number(block[end].slice(0, 3)), text: block.map((l) => l.slice(4)).join('\n') });
    }
    const onError = (e) => { failure = failure || e; pump(); };
    const attach = (s) => {
      s.on('data', onData);
      s.on('error', onError);
      s.on('close', () => onError(new Error('O servidor SMTP fechou a ligação')));
      s.setTimeout(timeoutMs, () => { onError(new Error('Tempo de espera do servidor SMTP esgotado')); s.destroy(); });
    };
    attach(socket);
    const reply = () => new Promise((resolve, reject) => { waiting = { resolve, reject }; pump(); });
    async function cmd(line, expect, label) {
      if (line !== null) socket.write(`${line}\r\n`);
      const r = await reply();
      if (!expect.includes(r.code)) throw new Error(`SMTP ${label || line.split(' ')[0]}: ${r.code} ${r.text}`);
      return r;
    }

    try {
      await cmd(null, [220], 'ligação');
      const helo = `EHLO ${os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'cmdb'}`;
      let ehlo = await cmd(helo, [250]);
      if (!cfg.secure && !connect && /\bSTARTTLS\b/i.test(ehlo.text)) {
        await cmd('STARTTLS', [220]);
        socket.removeAllListeners('data');
        socket.removeAllListeners('error');
        socket.removeAllListeners('close');
        socket.setTimeout(0);
        socket = tls.connect({ socket, servername: cfg.host, rejectUnauthorized: cfg.rejectUnauthorized !== false });
        attach(socket);
        await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
        ehlo = await cmd(helo, [250]);
      }
      if (cfg.user) {
        if (/AUTH[^\n]*\bPLAIN\b/i.test(ehlo.text)) {
          await cmd(`AUTH PLAIN ${b64(`\0${cfg.user}\0${cfg.pass || ''}`)}`, [235], 'AUTH');
        } else {
          await cmd('AUTH LOGIN', [334], 'AUTH');
          await cmd(b64(cfg.user), [334], 'AUTH');
          await cmd(b64(cfg.pass || ''), [235], 'AUTH');
        }
      }
      await cmd(`MAIL FROM:<${addrOnly(from)}>`, [250]);
      for (const r of recipients) await cmd(`RCPT TO:<${addrOnly(r)}>`, [250, 251]);
      await cmd('DATA', [354]);
      // "Dot-stuffing": linhas começadas por "." levam um ponto extra
      socket.write(`${message.replace(/^\./gm, '..')}\r\n.\r\n`);
      const done = await cmd(null, [250], 'DATA');
      socket.write('QUIT\r\n');
      socket.end();
      return { accepted: recipients, response: done.text };
    } catch (e) {
      socket.destroy();
      throw e;
    }
  }

  return { send, from: cfg.from, host: cfg.host };
}

module.exports = { createMailer, smtpConfigFromEnv, buildMessage };
