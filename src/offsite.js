'use strict';
/*
 * Cópia para fora do servidor: depois de cada cópia de segurança, corre o comando de CMDB_BACKUP_UPLOAD_CMD
 * com o caminho do ficheiro em BACKUP_FILE (e a chave em BACKUP_KEY_FILE, se existir). Exemplos:
 *   rclone copy "$BACKUP_FILE" remoto:rizoma-backups/
 *   aws s3 cp "$BACKUP_FILE" s3://rizoma-backups/ --storage-class STANDARD_IA
 * O comando corre numa shell, com tempo limite; o código de saída diferente de 0 conta como falha.
 */
const { spawn, spawnSync } = require('node:child_process');

/** Termina o processo e os filhos (com shell: true, matar só a shell deixava o comando real a correr). */
function killTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL'); // grupo de processos (spawn com detached: true)
  } catch { child.kill('SIGKILL'); }
}

function uploadBackup(command, { file, keyFile }, { timeoutMs = 30 * 60e3, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawnFn(command, {
      shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      env: { ...process.env, BACKUP_FILE: file, BACKUP_KEY_FILE: keyFile || '' },
    });
    let output = '';
    const keep = (d) => { output = (output + d).slice(-4000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => { output += '\n(tempo limite excedido)'; killTree(child); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, code: null, ms: Date.now() - started, output: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, ms: Date.now() - started, output: output.trim() }); });
  });
}

module.exports = { uploadBackup };
