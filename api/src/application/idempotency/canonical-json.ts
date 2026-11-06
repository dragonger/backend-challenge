/**
 * Deterministic JSON: object keys are sorted recursively (by UTF-16 code
 * unit), arrays keep their order, `undefined` properties are dropped, and no
 * insignificant whitespace is emitted.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};

    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) {
        sorted[key] = sortKeys(source[key]);
      }
    }

    return sorted;
  }

  return value;
}
