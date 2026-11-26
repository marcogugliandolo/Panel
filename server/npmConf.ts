/**
 * Lo que dice la configuración avanzada de un proxy host de NPM (o su archivo .conf): a dónde va de
 * verdad la portada (`location = /` o `location /` con su propio `proxy_pass`) y el respaldo para
 * cuando el destino falla (`error_page … = @respaldo` + `location @respaldo { proxy_pass … }`).
 */
export interface NpmTarget {
  scheme: string;
  host: string;
  port: number;
}

/** «http://casa.midominio.com:80/ruta» → { scheme, host, port }. Con variables de nginx no se sabe. */
export function parseProxyPass(url: string | null | undefined): NpmTarget | null {
  const m = String(url ?? '')
    .trim()
    .match(/^(https?):\/\/([^/:$\s;]+)(?::(\d+))?(?:[/?].*)?$/i);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  return { scheme, host: m[2].toLowerCase(), port: m[3] ? Number(m[3]) : scheme === 'https' ? 443 : 80 };
}

/** Bloques `location … { … }` con su contenido. */
function locations(text: string): { spec: string; body: string }[] {
  const out: { spec: string; body: string }[] = [];
  const re = /location\s+([^{]+?)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
    }
    out.push({ spec: m[1].trim(), body: text.slice(re.lastIndex, i - 1) });
  }
  return out;
}

const proxyPassIn = (body: string) => {
  const m = body.match(/(?:^|[;{\s])proxy_pass\s+([^;\s]+)\s*;/);
  return m && !m[1].includes('$') ? m[1] : null;
};

export function parseAdvanced(text: string | null | undefined): { root: string | null; fallback: string | null } {
  const conf = String(text ?? '').replace(/#[^\n]*/g, '');
  if (!conf.trim()) return { root: null, fallback: null };
  const locs = locations(conf);
  const exact = locs.find((l) => /^=\s*\/$/.test(l.spec));
  const slash = locs.find((l) => l.spec === '/');
  const root = (exact && proxyPassIn(exact.body)) || (slash && proxyPassIn(slash.body)) || null;
  let fallback: string | null = null;
  const named = conf.match(/error_page\s+[^;]*?(@[\w-]+)\s*;/);
  if (named) {
    const block = locs.find((l) => l.spec === named[1]);
    if (block) fallback = proxyPassIn(block.body);
  }
  return { root, fallback };
}
