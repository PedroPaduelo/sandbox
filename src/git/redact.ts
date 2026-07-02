/**
 * Sanitiza strings substituindo PATs em URLs `https://user:token@host` por [REDACTED].
 * Aplicar em qualquer log/response/erro que possa ter URL autenticada.
 */
const URL_AUTH_RE = /(https?:\/\/[^:@\s/]+):[^@\s]+@/g;

export function redactToken(s: string): string {
  if (!s) return s;
  return s.replace(URL_AUTH_RE, '$1:[REDACTED]@');
}
