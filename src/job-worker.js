'use strict';
/* Corpo da worker thread: abre a sua própria ligação à BD, corre uma tarefa (ver jobs.js) e devolve o resultado. */
const { workerData, parentPort } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { createStore } = require('./store');
const { HANDLERS } = require('./jobs');

const { dbFile, name, payload } = workerData;
let db;
try {
  db = new DatabaseSync(dbFile);
  // Espera mais do que a thread principal: uma importação pode ter de aguardar por escritas em curso
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 15000;');
  let result = HANDLERS[name](createStore(db), payload);
  // Buffers pequenos do Node partilham um ArrayBuffer comum: copia-se para um próprio antes de o transferir
  if (result instanceof Uint8Array) result = new Uint8Array(result);
  parentPort.postMessage({ result }, result instanceof Uint8Array ? [result.buffer] : []);
} catch (e) {
  parentPort.postMessage({ error: { message: e.message, status: e.status || null } });
} finally {
  if (db) db.close();
}
