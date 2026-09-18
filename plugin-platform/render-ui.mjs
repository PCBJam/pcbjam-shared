import { createHash } from 'node:crypto';
const hash = (text, encoding = 'hex') => createHash('sha256').update(text).digest(encoding);

/** Inputs are validated package HTML and PCBJam's build-generated SDK. */
export function renderPluginUI(html, sdkSource, parentOrigin, ancestorOrigins) {
  for (const origin of [parentOrigin, ...ancestorOrigins]) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !['https:', 'http:'].includes(parsed.protocol)) throw new Error('Invalid trusted UI origin');
  }
  if (!ancestorOrigins.includes(parentOrigin)) throw new Error('Parent must be a permitted ancestor');
  // The replacement is inside a JS string, never an HTML attribute. Origins are
  // trusted configuration but must still be escaped for both parsers.
  const sdk = sdkSource.replace('__PLUGIN_PARENT_ORIGIN__', JSON.stringify(parentOrigin).slice(1, -1).replaceAll('<', '\\u003c'));
  if (sdk.includes('</script')) throw new Error('Invalid trusted SDK');
  const body = `<!doctype html><meta charset="utf-8"><script>${sdk}</script>${html}`;
  const scripts = [...body.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(m => `'sha256-${hash(m[1], 'base64')}'`);
  const styles = [...body.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map(m => `'sha256-${hash(m[1], 'base64')}'`);
  // Embedded images make no request, so they open no egress channel. Remote images,
  // fonts and media stay denied by default-src; inline style attributes stay blocked.
  return { body, digest: hash(body), headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()',
    'Content-Security-Policy': `default-src 'none'; sandbox allow-scripts; script-src ${scripts.join(' ')}; style-src ${styles.length ? styles.join(' ') : "'none'"}; img-src data: blob:; worker-src 'none'; connect-src 'none'; frame-src 'none'; frame-ancestors ${ancestorOrigins.join(' ')}; object-src 'none'; base-uri 'none'; form-action 'none'`,
  }};
}
