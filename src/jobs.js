'use strict';
/*
 * Tarefas pesadas fora da thread principal.
 * O node:sqlite é síncrono: um relatório Excel grande, uma importação de 5000 linhas ou uma cópia de segurança
 * bloqueariam todos os outros pedidos. Com a BD num ficheiro, cada tarefa corre numa worker thread com a sua
 * própria ligação à BD (modo WAL: leituras em paralelo; escritas esperam até busy_timeout).
 * Com a BD em memória (testes) não há ficheiro para partilhar e as tarefas correm na própria thread.
 */
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { HttpError } = require('./http');
const { createImporter } = require('./importer');
const { readCiInput } = require('./validators');
const { buildReportXlsx } = require('./reports-data');
const { createBackups } = require('./backup');

/** As tarefas: funções (store, payload) → resultado serializável. Correm iguais na worker ou na thread principal. */
const HANDLERS = {
  'report-xlsx'(store, { clientId }) {
    const c = store.one('SELECT * FROM clients WHERE id = ?', clientId);
    if (!c) throw new HttpError(404, 'Cliente não encontrado');
    return buildReportXlsx(store, c);
  },
  import(store, { user, clientId, rows, options }) {
    const importer = createImporter({ ...store, readCiInput });
    try {
      return importer.importRows(user, clientId, rows, options);
    } catch (e) {
      if (e.status && !(e instanceof HttpError)) throw new HttpError(e.status, e.message);
      throw e;
    }
  },
  backup(store, { dir, keep, keyFile }) {
    return createBackups({ db: store.db, dir, keep, keyFile }).run();
  },
};

function createJobs({ store, dbFile, inline = false, maxWorkers = 2 }) {
  const useWorker = !inline && !!dbFile && dbFile !== ':memory:';
  let running = 0;
  const queue = [];
  const release = () => { running--; const next = queue.shift(); if (next) next(); };
  const slot = () => new Promise((resolve) => { if (running < maxWorkers) { running++; resolve(); } else queue.push(() => { running++; resolve(); }); });

  function inWorker(name, payload) {
    return new Promise((resolve, reject) => {
      const w = new Worker(path.join(__dirname, 'job-worker.js'), { workerData: { dbFile, name, payload } });
      let settled = false;
      w.once('message', (m) => {
        settled = true;
        if (m.error) reject(m.error.status ? new HttpError(m.error.status, m.error.message) : new Error(m.error.message));
        else resolve(m.result);
      });
      w.once('error', (e) => { settled = true; reject(e); });
      w.once('exit', (code) => { if (!settled) reject(new Error(`A tarefa "${name}" terminou sem resultado (código ${code})`)); });
    });
  }

  /** Executa uma tarefa; devolve uma Promise com o resultado. */
  async function runJob(name, payload) {
    if (!HANDLERS[name]) throw new Error(`Tarefa desconhecida: ${name}`);
    if (!useWorker) return HANDLERS[name](store, payload);
    await slot();
    try { return await inWorker(name, payload); } finally { release(); }
  }

  return { runJob, mode: useWorker ? 'worker' : 'inline' };
}

module.exports = { createJobs, HANDLERS };
