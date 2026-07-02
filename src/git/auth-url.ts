/**
 * Injeta PAT como `x-access-token:<token>` em URL HTTPS para clone autenticado.
 * SSH/non-HTTP retornam inalterados.
 */
export function buildAuthenticatedUrl(url: string, token: string | undefined): string {
  if (!token) return url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url; // não é URL parsable (ex.: SSH git@host:path)
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return url;
  u.username = 'x-access-token';
  u.password = encodeURIComponent(token);
  return u.toString();
}
