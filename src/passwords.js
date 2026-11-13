'use strict';
/* Política de passwords: comprimento mínimo, variedade de caracteres e rejeição de passwords óbvias. */

const DEFAULT_ADMIN_PASSWORD = 'admin123';
const MIN_LENGTH = 10;

// Passwords mais comuns (e variações óbvias para este produto). Comparação sem maiúsculas.
const COMMON = new Set([
  'password', 'password1', 'password123', 'passw0rd', 'p@ssw0rd', 'p@ssword', '123456', '12345678', '123456789',
  '1234567890', '0123456789', 'qwerty', 'qwerty123', 'qwertyuiop', 'azerty', 'abc123', 'abcd1234', 'iloveyou',
  'letmein', 'welcome', 'welcome1', 'welcome123', 'monkey', 'dragon', 'football', 'sunshine', 'princess',
  'admin', 'admin1', 'admin123', 'admin1234', 'administrator', 'administrador', 'root', 'toor', 'changeme',
  'mudar123', 'mudarsenha', 'senha', 'senha123', 'senha1234', 'palavrapasse', 'portugal', 'benfica', 'sporting',
  'cmdb', 'cmdb123', 'cmdb1234', 'cmdbadmin', 'secret', 'secret123', 'trustno1', '1q2w3e4r', '1qaz2wsx',
  'zaq12wsx', 'aaaaaaaaaa', '1111111111', 'abcdefghij',
]);

/** Devolve null se a password é aceitável, ou a mensagem de erro (em português). */
function passwordProblem(password, username) {
  const pw = String(password || '');
  if (pw.length < MIN_LENGTH) return `A password deve ter pelo menos ${MIN_LENGTH} caracteres`;
  if (pw.length > 200) return 'A password é demasiado longa (máx. 200 caracteres)';
  const lower = pw.toLowerCase();
  if (COMMON.has(lower) || COMMON.has(lower.replace(/[^a-z0-9@]/g, ''))) return 'Essa password é demasiado comum. Escolha outra.';
  if (/^(.)\1+$/.test(pw)) return 'A password não pode ser um único carácter repetido';
  const user = String(username || '').toLowerCase();
  if (user.length >= 4 && lower.includes(user)) return 'A password não pode conter o nome de utilizador';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (classes < 2) return 'A password deve combinar pelo menos dois tipos de caracteres (minúsculas, maiúsculas, números ou símbolos)';
  return null;
}

module.exports = { passwordProblem, DEFAULT_ADMIN_PASSWORD, MIN_LENGTH };
