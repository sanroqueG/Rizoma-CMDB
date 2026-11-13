'use strict';
/* Tema claro/escuro do Tabler (data-bs-theme) a seguir a preferência do sistema operativo. */
(function () {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => document.documentElement.setAttribute('data-bs-theme', mq.matches ? 'dark' : 'light');
  apply();
  mq.addEventListener('change', apply);
}());
