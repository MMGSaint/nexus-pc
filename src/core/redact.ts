/**
 * Redaction applied before anything is written to the audit log or a
 * diagnostic log. Two mechanisms, because either alone is insufficient:
 *
 *  - key based: fields whose *name* suggests a credential are masked;
 *  - value based: exact secret strings registered at runtime (for example the
 *    Vesper auth token loaded from disk) are scrubbed wherever they appear,
 *    including inside an error message that quoted them.
 */

const SENSITIVE_KEY = /(token|secret|password|passwd|credential|authorization|cookie|api[_-]?key|private[_-]?key|signature)/i;

export const REDACTED = '[redacted]';

const registeredSecrets = new Set<string>();

/** Register a literal secret so it is scrubbed from all future output. */
export function registerSecret(secret: string): void {
  // Very short strings would scrub harmless text; refuse them.
  if (typeof secret === 'string' && secret.length >= 8) registeredSecrets.add(secret);
}

export function clearRegisteredSecrets(): void {
  registeredSecrets.clear();
}

export function scrubString(input: string): string {
  let out = input;
  for (const secret of registeredSecrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[depth-limit]';
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key === '__proto__') continue;
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}
