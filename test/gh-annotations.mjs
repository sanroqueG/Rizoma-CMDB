// Reporter para o GitHub Actions: cada teste falhado vira uma anotação "::error" (ver .github/workflows/ci.yml).
export default async function* ghAnnotations(source) {
  for await (const event of source) {
    if (event.type !== 'test:fail') continue;
    const d = event.data;
    const err = d.details?.error;
    const cause = err?.cause ?? err;
    const msg = String(cause?.message ?? err?.message ?? 'falhou').replace(/\r?\n/g, '%0A').slice(0, 2000);
    const file = d.file ? d.file.replace(/^.*?\/test\//, 'test/') : '';
    yield `::error ${file ? `file=${file},` : ''}line=${d.line ?? 1},title=${String(d.name).replace(/[,:\n]/g, ' ')}::${msg}\n`;
  }
}
