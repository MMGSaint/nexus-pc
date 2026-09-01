/**
 * Defence in depth for untrusted payloads.
 *
 * The schema validators already reject unknown fields, so a payload carrying
 * `bypassSafety: true` fails to parse. This module exists so that a *nested*
 * or free-form region of a payload (notes, rationale text, data blobs that are
 * legitimately open-ended) still cannot carry an authority claim, and so the
 * attempt is recorded rather than silently dropped.
 */

import { isPlainObject } from '../core/validate.js';

/**
 * Field names that would only ever appear in an attempt to assert privilege.
 * NEXUS has no feature that reads any of them; their presence is evidence of
 * an attempted bypass, so it is reported.
 */
export const FORBIDDEN_AUTHORITY_KEYS: readonly string[] = Object.freeze([
  'bypasssafety',
  'disablesafety',
  'safetydisabled',
  'skipvalidation',
  'skipsafety',
  'ignoresafety',
  'allowprohibited',
  'elevate',
  'elevated',
  'privileged',
  'authority',
  'trusted',
  'asadmin',
  'runasadmin',
  'overridepolicy',
  'policyoverride',
  'forceunsafe',
  'unsafe',
  'nolimits',
  'unrestricted',
]);

const FORBIDDEN = new Set(FORBIDDEN_AUTHORITY_KEYS);

export interface AuthorityScanResult {
  readonly clean: boolean;
  readonly offendingPaths: readonly string[];
}

function normalise(key: string): string {
  return key.toLowerCase().replace(/[^a-z]/g, '');
}

/** Recursively scan for authority-claiming field names. */
export function scanForAuthorityClaims(value: unknown, maxDepth = 12): AuthorityScanResult {
  const offending: string[] = [];

  const walk = (node: unknown, depth: number, path: string): void => {
    if (depth > maxDepth || offending.length >= 8) return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, depth + 1, `${path}[${i}]`));
      return;
    }
    if (!isPlainObject(node)) return;
    for (const [key, child] of Object.entries(node)) {
      const here = path === '' ? key : `${path}.${key}`;
      if (FORBIDDEN.has(normalise(key))) offending.push(here);
      walk(child, depth + 1, here);
    }
  };

  walk(value, 0, '');
  return { clean: offending.length === 0, offendingPaths: offending };
}
