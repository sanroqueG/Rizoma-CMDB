/* Tipos dos scripts clássicos carregados antes dos módulos (index.html). */
declare const Graph: { render(g: unknown, opts?: Record<string, unknown>): HTMLElement; layout(g: unknown): unknown };
declare const QR: { toSvg(text: string, size?: number): SVGElement; encode(text: string): unknown };
declare const FileTables: { readTable(f: File): Promise<{ headers: string[]; rows: Record<string, string>[] }> };
