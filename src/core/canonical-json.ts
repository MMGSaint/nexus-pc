/**
 * Deterministic JSON serialisation used for hashing audit records and for
 * comparing structural equality of control values. Keys are sorted; undefined
 * members are dropped; non-finite numbers are rejected rather than silently
 * becoming null (a NaN in an audit hash would be a silent integrity hole).
 */

export function canonicalJson(value: unknown): string {
  return stringify(value, new WeakSet<object>());
}

function stringify(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: non-finite number (${String(value)})`);
      }
      // Normalise -0 to 0 so equal values hash equally.
      return JSON.stringify(value === 0 ? 0 : value);
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
      throw new TypeError('canonicalJson: bigint is not serialisable');
    case 'undefined':
    case 'function':
    case 'symbol':
      throw new TypeError(`canonicalJson: ${typeof value} is not serialisable`);
    default:
      break;
  }

  const obj = value as object;
  if (seen.has(obj)) throw new TypeError('canonicalJson: circular structure');
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts = obj.map((item) => (item === undefined ? 'null' : stringify(item, seen)));
      return `[${parts.join(',')}]`;
    }
    const record = obj as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = record[key];
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${stringify(v, seen)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}

/** Structural equality via canonical form. Used to compare control values. */
export function structurallyEqual(a: unknown, b: unknown): boolean {
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
  }
}
