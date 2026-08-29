/**
 * A small, dependency-free schema validator.
 *
 * NEXUS deliberately does not take a runtime validation dependency: every byte
 * that crosses a trust boundary (config files, Vesper requests, persisted
 * state, provider output) is parsed by code in this repository.
 *
 * Two properties matter for safety:
 *  1. `vObject` rejects unknown keys by default. Untrusted callers therefore
 *     cannot smuggle extra fields such as `bypassSafety` through a payload and
 *     hope some later layer reads them.
 *  2. Every collection accepts a bound, so a hostile payload cannot make NEXUS
 *     allocate without limit.
 */

import type { Result } from './result.js';
import { err, ok } from './result.js';

export interface Issue {
  readonly path: string;
  readonly message: string;
}

export interface Validator<T> {
  readonly kind: string;
  readonly optional?: boolean;
  parse(input: unknown, path?: string): Result<T, Issue[]>;
}

export interface OptionalValidator<T> extends Validator<T | undefined> {
  readonly optional: true;
}

function issue(path: string, message: string): Issue[] {
  return [{ path: path === '' ? '<root>' : path, message }];
}

function define<T>(kind: string, parse: (input: unknown, path: string) => Result<T, Issue[]>): Validator<T> {
  return { kind, parse: (input, path = '') => parse(input, path) };
}

/* ------------------------------------------------------------------ scalars */

export interface StringOptions {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: RegExp;
  readonly trim?: boolean;
}

/** Strings are bounded by default so untrusted input cannot balloon memory. */
export function vString(options: StringOptions = {}): Validator<string> {
  const max = options.maxLength ?? 4096;
  return define('string', (input, path) => {
    if (typeof input !== 'string') return err(issue(path, `expected string, got ${typeName(input)}`));
    const value = options.trim ? input.trim() : input;
    if (value.length > max) return err(issue(path, `string longer than ${max} characters`));
    if (options.minLength !== undefined && value.length < options.minLength) {
      return err(issue(path, `string shorter than ${options.minLength} characters`));
    }
    if (options.pattern && !options.pattern.test(value)) {
      return err(issue(path, `string does not match ${options.pattern.source}`));
    }
    return ok(value);
  });
}

export interface NumberOptions {
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
}

/**
 * Numbers must be finite. NaN and Infinity are rejected rather than coerced:
 * a NaN threshold silently disables every comparison it participates in.
 */
export function vNumber(options: NumberOptions = {}): Validator<number> {
  return define('number', (input, path) => {
    if (typeof input !== 'number') return err(issue(path, `expected number, got ${typeName(input)}`));
    if (!Number.isFinite(input)) return err(issue(path, 'number must be finite'));
    if (options.integer && !Number.isInteger(input)) return err(issue(path, 'number must be an integer'));
    if (options.min !== undefined && input < options.min) return err(issue(path, `number below minimum ${options.min}`));
    if (options.max !== undefined && input > options.max) return err(issue(path, `number above maximum ${options.max}`));
    return ok(input);
  });
}

export function vBoolean(): Validator<boolean> {
  return define('boolean', (input, path) =>
    typeof input === 'boolean' ? ok(input) : err(issue(path, `expected boolean, got ${typeName(input)}`)),
  );
}

export function vLiteral<const T extends string | number | boolean>(literal: T): Validator<T> {
  return define(`literal(${String(literal)})`, (input, path) =>
    input === literal ? ok(literal) : err(issue(path, `expected ${JSON.stringify(literal)}`)),
  );
}

export function vEnum<const T extends readonly string[]>(values: T): Validator<T[number]> {
  const set = new Set<string>(values);
  return define(`enum(${values.join('|')})`, (input, path) => {
    if (typeof input !== 'string' || !set.has(input)) {
      return err(issue(path, `expected one of ${values.join(', ')}`));
    }
    return ok(input as T[number]);
  });
}

/** Explicitly allows null. Distinct from "absent" and distinct from zero. */
export function vNullable<T>(inner: Validator<T>): Validator<T | null> {
  return define(`nullable(${inner.kind})`, (input, path) =>
    input === null ? ok(null) : inner.parse(input, path),
  );
}

export function vUnknown(): Validator<unknown> {
  return define('unknown', (input) => ok(input));
}

/* ------------------------------------------------------------- collections */

export interface ArrayOptions {
  readonly maxItems?: number;
  readonly minItems?: number;
}

export function vArray<T>(item: Validator<T>, options: ArrayOptions = {}): Validator<T[]> {
  const max = options.maxItems ?? 1024;
  return define(`array(${item.kind})`, (input, path) => {
    if (!Array.isArray(input)) return err(issue(path, `expected array, got ${typeName(input)}`));
    if (input.length > max) return err(issue(path, `array longer than ${max} items`));
    if (options.minItems !== undefined && input.length < options.minItems) {
      return err(issue(path, `array shorter than ${options.minItems} items`));
    }
    const out: T[] = [];
    const issues: Issue[] = [];
    for (let i = 0; i < input.length; i += 1) {
      const r = item.parse(input[i], `${path}[${i}]`);
      if (r.ok) out.push(r.value);
      else issues.push(...r.error);
    }
    return issues.length > 0 ? err(issues) : ok(out);
  });
}

export interface RecordOptions {
  readonly maxKeys?: number;
  readonly keyPattern?: RegExp;
}

export function vRecord<T>(value: Validator<T>, options: RecordOptions = {}): Validator<Record<string, T>> {
  const max = options.maxKeys ?? 256;
  return define(`record(${value.kind})`, (input, path) => {
    if (!isPlainObject(input)) return err(issue(path, `expected object, got ${typeName(input)}`));
    const keys = Object.keys(input);
    if (keys.length > max) return err(issue(path, `object has more than ${max} keys`));
    const out: Record<string, T> = Object.create(null) as Record<string, T>;
    const issues: Issue[] = [];
    for (const key of keys) {
      if (options.keyPattern && !options.keyPattern.test(key)) {
        issues.push(...issue(`${path}.${key}`, `key does not match ${options.keyPattern.source}`));
        continue;
      }
      const r = value.parse(input[key], `${path}.${key}`);
      if (r.ok) out[key] = r.value;
      else issues.push(...r.error);
    }
    return issues.length > 0 ? err(issues) : ok(out);
  });
}

/* ----------------------------------------------------------------- objects */

export function vOptional<T>(inner: Validator<T>): OptionalValidator<T> {
  return {
    kind: `optional(${inner.kind})`,
    optional: true,
    parse: (input, path = '') => (input === undefined ? ok(undefined) : inner.parse(input, path)),
  };
}

type Shape = Record<string, Validator<unknown>>;

type Infer<V> = V extends Validator<infer T> ? T : never;
type OptionalKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends { optional: true } ? K : never;
}[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;

export type ObjectOutput<S extends Shape> = {
  [K in RequiredKeys<S>]: Infer<S[K]>;
} & {
  [K in OptionalKeys<S>]?: Infer<S[K]>;
};

export interface ObjectOptions {
  /**
   * When false (the default) unknown keys are an error. Leave it false for
   * anything that crosses a trust boundary.
   */
  readonly allowUnknown?: boolean;
}

export function vObject<S extends Shape>(
  shape: S,
  options: ObjectOptions = {},
): Validator<ObjectOutput<S>> {
  const known = new Set(Object.keys(shape));
  return define(`object(${Object.keys(shape).join(',')})`, (input, path) => {
    if (!isPlainObject(input)) return err(issue(path, `expected object, got ${typeName(input)}`));

    const issues: Issue[] = [];
    if (!options.allowUnknown) {
      for (const key of Object.keys(input)) {
        if (!known.has(key)) {
          issues.push(...issue(path === '' ? key : `${path}.${key}`, 'unknown field is not permitted'));
        }
      }
    }

    const out: Record<string, unknown> = {};
    for (const key of known) {
      const validator = shape[key];
      /* istanbul ignore next - `known` is derived from `shape` */
      if (!validator) continue;
      const present = Object.hasOwn(input, key);
      const raw = present ? input[key] : undefined;
      if (!present && validator.optional !== true) {
        issues.push(...issue(path === '' ? key : `${path}.${key}`, 'required field is missing'));
        continue;
      }
      if (!present) continue;
      if (raw === undefined && validator.optional === true) continue;
      const r = validator.parse(raw, path === '' ? key : `${path}.${key}`);
      if (r.ok) out[key] = r.value;
      else issues.push(...r.error);
    }

    return issues.length > 0 ? err(issues) : ok(out as ObjectOutput<S>);
  });
}

export function vUnion<T extends readonly Validator<unknown>[]>(
  ...members: T
): Validator<Infer<T[number]>> {
  return define(`union(${members.map((m) => m.kind).join('|')})`, (input, path) => {
    const collected: Issue[] = [];
    for (const member of members) {
      const r = member.parse(input, path);
      if (r.ok) return ok(r.value as Infer<T[number]>);
      collected.push(...r.error);
    }
    return err([
      { path: path === '' ? '<root>' : path, message: 'value did not match any permitted shape' },
      ...collected,
    ]);
  });
}

/* --------------------------------------------------------------- utilities */

/**
 * `Object.prototype` is deliberately excluded: an input parsed from JSON with a
 * `__proto__` key would otherwise be able to influence prototype lookups.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export interface ShapeGuardOptions {
  readonly maxDepth?: number;
  readonly maxNodes?: number;
}

/**
 * Structural guard applied to untrusted payloads *before* schema parsing.
 * Bounds nesting depth and total node count so a small hostile document cannot
 * cost an unbounded amount of work, and rejects the `__proto__` key outright.
 */
export function assertSafeShape(
  value: unknown,
  options: ShapeGuardOptions = {},
): Result<true, Issue[]> {
  const maxDepth = options.maxDepth ?? 16;
  const maxNodes = options.maxNodes ?? 5000;
  let nodes = 0;

  const walk = (node: unknown, depth: number, path: string): Issue[] | null => {
    nodes += 1;
    if (nodes > maxNodes) return issue(path, `payload has more than ${maxNodes} nodes`);
    if (depth > maxDepth) return issue(path, `payload nested deeper than ${maxDepth} levels`);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        const found = walk(node[i], depth + 1, `${path}[${i}]`);
        if (found) return found;
      }
      return null;
    }
    if (typeof node === 'object' && node !== null) {
      if (!isPlainObject(node)) return issue(path, 'expected a plain object');
      for (const key of Object.keys(node)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          return issue(path === '' ? key : `${path}.${key}`, 'reserved key is not permitted');
        }
        const found = walk(node[key], depth + 1, path === '' ? key : `${path}.${key}`);
        if (found) return found;
      }
    }
    return null;
  };

  const found = walk(value, 0, '');
  return found ? err(found) : ok(true);
}

export function formatIssues(issues: readonly Issue[], limit = 8): string {
  return issues
    .slice(0, limit)
    .map((i) => `${i.path}: ${i.message}`)
    .join('; ');
}
