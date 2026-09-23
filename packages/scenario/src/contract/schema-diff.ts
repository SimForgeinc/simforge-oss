/**
 * Structural diff of two JSON Schemas (draft 2020-12, as zod emits them),
 * classified as ADDITIVE or BREAKING for scenario documents.
 *
 * The question it answers: "can every document that was valid before still be
 * read with the same meaning?" An additive change only widens what may be
 * written and gives old documents the same meaning:
 *
 * - a new optional property;
 * - a widened enum (values added, none removed), a widened `type`;
 * - a new union alternative;
 * - a relaxed bound (a larger maximum, a smaller minimum, a dropped pattern);
 * - `additionalProperties` newly allowed.
 *
 * Everything else is breaking, including anything this classifier does not
 * specifically recognise as a widening: a removed or renamed property, a type
 * change, a new required property, a required property made optional, a
 * narrowed enum or bound, a new constraint, and any change to a `default`
 * (which changes what an absent field means).
 *
 * Annotation keywords (`title`, `description`, `$comment`, `examples`, `$id`,
 * `$schema`, `deprecated`, `readOnly`, `writeOnly`) are ignored.
 */

/** A JSON-schema node. */
export type JsonSchema = boolean | { readonly [keyword: string]: unknown };

/** One classified difference. `path` is a document path (`roles[].kind`). */
export interface SchemaChange {
  readonly path: string;
  readonly change: string;
}

export interface SchemaDiff {
  readonly additive: readonly SchemaChange[];
  readonly breaking: readonly SchemaChange[];
}

const ANNOTATIONS = new Set([
  'title',
  'description',
  '$comment',
  'examples',
  '$id',
  '$schema',
  'deprecated',
  'readOnly',
  'writeOnly',
]);
const SUBSCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const SUBSCHEMA_SINGLES = new Set([
  'additionalProperties',
  'items',
  'additionalItems',
  'not',
  'propertyNames',
  'contains',
  'if',
  'then',
  'else',
  'unevaluatedProperties',
  'unevaluatedItems',
]);
const SUBSCHEMA_ARRAYS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);
/** Unordered string sets: sorted when normalizing. */
const SET_KEYWORDS = new Set(['required', 'type']);

/** Lower is wider. */
const LOWER_BOUNDS = new Set(['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties', 'minContains']);
/** Higher is wider. */
const UPPER_BOUNDS = new Set(['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties', 'maxContains']);
/** Constraints whose removal widens and whose addition or change narrows. */
const DROPPABLE_CONSTRAINTS = new Set(['pattern', 'format', 'multipleOf', 'contentEncoding', 'contentMediaType']);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
  return out;
}

function stable(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/**
 * The canonical snapshot form of a schema: annotations stripped (only in
 * schema positions, so a property that happens to be named `description`
 * survives), string sets sorted, enums sorted, object keys sorted.
 */
export function normalizeJsonSchema(schema: unknown): JsonSchema {
  if (typeof schema === 'boolean') return schema;
  if (!isObject(schema)) throw new Error(`not a JSON schema node: ${JSON.stringify(schema)}`);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(schema).sort()) {
    if (ANNOTATIONS.has(key)) continue;
    const value = schema[key];
    if (SUBSCHEMA_MAPS.has(key) && isObject(value)) {
      const map: Record<string, unknown> = {};
      for (const name of Object.keys(value).sort()) map[name] = normalizeJsonSchema(value[name]);
      out[key] = map;
    } else if (SUBSCHEMA_SINGLES.has(key) && (typeof value === 'boolean' || isObject(value))) {
      out[key] = normalizeJsonSchema(value);
    } else if (SUBSCHEMA_ARRAYS.has(key) && Array.isArray(value)) {
      out[key] = value.map(normalizeJsonSchema);
    } else if (SET_KEYWORDS.has(key) && Array.isArray(value)) {
      out[key] = [...value].sort();
    } else if (key === 'enum' && Array.isArray(value)) {
      out[key] = [...value].sort((a, b) => (stable(a) < stable(b) ? -1 : stable(a) > stable(b) ? 1 : 0));
    } else {
      out[key] = sortKeys(value);
    }
  }
  return out;
}

interface DiffContext {
  readonly beforeRoot: JsonSchema;
  readonly afterRoot: JsonSchema;
  readonly seenRefPairs: Set<string>;
  readonly additive: SchemaChange[];
  readonly breaking: SchemaChange[];
  /** Root-level properties the diff skips (the version field itself). */
  readonly ignoreRootProperties: ReadonlySet<string>;
}

function display(path: string): string {
  return path === '' ? '<root>' : path;
}

function joinProperty(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

function deref(root: JsonSchema, ref: string): JsonSchema {
  const match = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
  if (!match || !isObject(root)) throw new Error(`unsupported $ref ${ref}`);
  const defs = root[match[1]!];
  const name = match[2]!.replace(/~1/g, '/').replace(/~0/g, '~');
  if (!isObject(defs) || !(name in defs)) throw new Error(`dangling $ref ${ref}`);
  return defs[name] as JsonSchema;
}

function withoutKeys(schema: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) if (!keys.includes(key)) out[key] = value;
  return out;
}

function allowedValues(schema: Record<string, unknown>): readonly unknown[] | undefined {
  if (Array.isArray(schema['enum'])) return schema['enum'] as unknown[];
  if ('const' in schema) return [schema['const']];
  return undefined;
}

function typeSet(schema: Record<string, unknown>): readonly string[] | undefined {
  const type = schema['type'];
  if (typeof type === 'string') return [type];
  if (Array.isArray(type)) return type as string[];
  return undefined;
}

/** A best-effort identity for a union alternative, so reordering is not a change. */
function branchSignature(root: JsonSchema, branch: JsonSchema, depth = 0): string {
  if (typeof branch === 'boolean') return String(branch);
  if (typeof branch['$ref'] === 'string') {
    return depth > 4 ? branch['$ref'] : `ref:${branchSignature(root, deref(root, branch['$ref']), depth + 1)}`;
  }
  const discriminators: string[] = [];
  const properties = branch['properties'];
  if (isObject(properties)) {
    for (const key of Object.keys(properties).sort()) {
      const property = properties[key];
      if (isObject(property) && 'const' in property) discriminators.push(`${key}=${stable(property['const'])}`);
    }
  }
  if (discriminators.length > 0) return `{${discriminators.join(',')}}`;
  // Deliberately coarse: a signature must survive a widening INSIDE the branch
  // (a new optional property, an added enum value). Colliding signatures fall
  // back to positional matching in compareUnion.
  const types = typeSet(branch)?.join('|') ?? 'any';
  if ('const' in branch) return `const:${stable(branch['const'])}`;
  if (Array.isArray(branch['enum'])) return `enum:${types}`;
  if (Array.isArray(branch['anyOf']) || Array.isArray(branch['oneOf'])) return `union:${types}`;
  return types;
}

function compareUnion(
  ctx: DiffContext,
  keyword: string,
  before: readonly JsonSchema[],
  after: readonly JsonSchema[],
  path: string,
): void {
  const beforeSigs = before.map((branch) => branchSignature(ctx.beforeRoot, branch));
  const afterSigs = after.map((branch) => branchSignature(ctx.afterRoot, branch));
  const unique = new Set(beforeSigs).size === beforeSigs.length && new Set(afterSigs).size === afterSigs.length;
  if (!unique) {
    if (before.length !== after.length) {
      ctx.breaking.push({ path: display(path), change: `${keyword} alternatives changed (${before.length} -> ${after.length}) and cannot be matched` });
      return;
    }
    before.forEach((branch, index) => compareNode(ctx, branch, after[index]!, `${path}<${keyword}:${index}>`));
    return;
  }
  beforeSigs.forEach((signature, index) => {
    const match = afterSigs.indexOf(signature);
    if (match === -1) {
      ctx.breaking.push({ path: display(path), change: `${keyword} alternative removed or changed: ${signature}` });
    } else {
      compareNode(ctx, before[index]!, after[match]!, `${path}<${signature}>`);
    }
  });
  afterSigs.forEach((signature) => {
    if (!beforeSigs.includes(signature)) {
      ctx.additive.push({ path: display(path), change: `${keyword} alternative added: ${signature}` });
    }
  });
}

function compareBound(ctx: DiffContext, keyword: string, before: unknown, after: unknown, path: string): void {
  const lower = LOWER_BOUNDS.has(keyword);
  if (after === undefined) {
    ctx.additive.push({ path: display(path), change: `${keyword} ${String(before)} removed (widened)` });
  } else if (before === undefined) {
    ctx.breaking.push({ path: display(path), change: `new ${keyword} ${String(after)} (narrowed)` });
  } else if (typeof before === 'number' && typeof after === 'number') {
    const widened = lower ? after < before : after > before;
    (widened ? ctx.additive : ctx.breaking).push({
      path: display(path),
      change: `${keyword} ${before} -> ${after} (${widened ? 'widened' : 'narrowed'})`,
    });
  } else {
    ctx.breaking.push({ path: display(path), change: `${keyword} ${stable(before)} -> ${stable(after)}` });
  }
}

function compareProperties(
  ctx: DiffContext,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  path: string,
): void {
  const beforeProps = isObject(before['properties']) ? before['properties'] : {};
  const afterProps = isObject(after['properties']) ? after['properties'] : {};
  const beforeRequired = new Set(Array.isArray(before['required']) ? (before['required'] as string[]) : []);
  const afterRequired = new Set(Array.isArray(after['required']) ? (after['required'] as string[]) : []);
  const atRoot = path === '';
  for (const key of Object.keys(beforeProps)) {
    if (atRoot && ctx.ignoreRootProperties.has(key)) continue;
    const propertyPath = joinProperty(path, key);
    if (!(key in afterProps)) {
      ctx.breaking.push({ path: propertyPath, change: 'property removed or renamed' });
      continue;
    }
    if (!beforeRequired.has(key) && afterRequired.has(key)) {
      ctx.breaking.push({ path: propertyPath, change: 'optional property became required' });
    } else if (beforeRequired.has(key) && !afterRequired.has(key)) {
      ctx.breaking.push({
        path: propertyPath,
        change: 'required property became optional (its absence now needs a declared meaning)',
      });
    }
    compareNode(ctx, beforeProps[key] as JsonSchema, afterProps[key] as JsonSchema, propertyPath);
  }
  for (const key of Object.keys(afterProps)) {
    if (key in beforeProps || (atRoot && ctx.ignoreRootProperties.has(key))) continue;
    const propertyPath = joinProperty(path, key);
    if (afterRequired.has(key)) {
      ctx.breaking.push({ path: propertyPath, change: 'new required property' });
    } else {
      const added = afterProps[key];
      const fallback = isObject(added) && 'default' in added ? ` (default ${stable(added['default'])})` : '';
      ctx.additive.push({ path: propertyPath, change: `new optional property${fallback}` });
    }
  }
}

function compareNode(ctx: DiffContext, before: JsonSchema, after: JsonSchema, path: string): void {
  if (typeof before === 'boolean' || typeof after === 'boolean') {
    if (stable(before) === stable(after)) return;
    if (after === true || before === false) {
      ctx.additive.push({ path: display(path), change: `schema widened (${stable(before)} -> ${stable(after)})` });
    } else {
      ctx.breaking.push({ path: display(path), change: `schema narrowed (${stable(before)} -> ${stable(after)})` });
    }
    return;
  }
  const beforeRef = typeof before['$ref'] === 'string' ? before['$ref'] : undefined;
  const afterRef = typeof after['$ref'] === 'string' ? after['$ref'] : undefined;
  if (beforeRef !== undefined || afterRef !== undefined) {
    const pairKey = `${beforeRef ?? `inline@${path}`}|${afterRef ?? `inline@${path}`}`;
    if (!ctx.seenRefPairs.has(pairKey)) {
      ctx.seenRefPairs.add(pairKey);
      compareNode(
        ctx,
        beforeRef !== undefined ? deref(ctx.beforeRoot, beforeRef) : withoutKeys(before, ['$ref']),
        afterRef !== undefined ? deref(ctx.afterRoot, afterRef) : withoutKeys(after, ['$ref']),
        path,
      );
    }
    // Keywords written beside a `$ref` (a default, a narrower bound) apply too.
    const beforeSiblings = beforeRef !== undefined ? withoutKeys(before, ['$ref']) : {};
    const afterSiblings = afterRef !== undefined ? withoutKeys(after, ['$ref']) : {};
    if (Object.keys(beforeSiblings).length > 0 || Object.keys(afterSiblings).length > 0) {
      compareNode(ctx, beforeSiblings, afterSiblings, path);
    }
    return;
  }

  const keywords = new Set([...Object.keys(before), ...Object.keys(after)]);
  let valuesCompared = false;
  for (const keyword of [...keywords].sort()) {
    if (ANNOTATIONS.has(keyword) || keyword === '$defs' || keyword === 'definitions') continue;
    const b = before[keyword];
    const a = after[keyword];
    switch (keyword) {
      case 'properties':
        compareProperties(ctx, before, after, path);
        break;
      case 'required':
        // Handled per property in compareProperties (old/new/optional/required).
        if (!('properties' in before) && !('properties' in after) && stable(b) !== stable(a)) {
          ctx.breaking.push({ path: display(path), change: `required ${stable(b)} -> ${stable(a)}` });
        }
        break;
      case 'type': {
        const beforeTypes = typeSet(before);
        const afterTypes = typeSet(after);
        if (stable(beforeTypes) === stable(afterTypes)) break;
        if (afterTypes === undefined) {
          ctx.additive.push({ path: display(path), change: `type constraint ${stable(beforeTypes)} removed (widened)` });
        } else if (beforeTypes === undefined) {
          ctx.breaking.push({ path: display(path), change: `new type constraint ${stable(afterTypes)}` });
        } else if (beforeTypes.every((type) => afterTypes.includes(type))) {
          ctx.additive.push({ path: display(path), change: `type widened ${stable(beforeTypes)} -> ${stable(afterTypes)}` });
        } else {
          ctx.breaking.push({ path: display(path), change: `type changed ${stable(beforeTypes)} -> ${stable(afterTypes)}` });
        }
        break;
      }
      case 'enum':
      case 'const': {
        // Compared once per node, as the set of allowed values (a const is a
        // one-value enum, so const -> enum [same, more] is a widening).
        if (valuesCompared) break;
        valuesCompared = true;
        const beforeValues = allowedValues(before);
        const afterValues = allowedValues(after);
        if (stable(beforeValues) === stable(afterValues)) break;
        if (afterValues === undefined) {
          ctx.additive.push({ path: display(path), change: `allowed values ${stable(beforeValues)} no longer restricted (widened)` });
        } else if (beforeValues === undefined) {
          ctx.breaking.push({ path: display(path), change: `values newly restricted to ${stable(afterValues)}` });
        } else {
          const afterKeys = new Set(afterValues.map(stable));
          const beforeKeys = new Set(beforeValues.map(stable));
          const removed = [...beforeKeys].filter((value) => !afterKeys.has(value));
          const added = [...afterKeys].filter((value) => !beforeKeys.has(value));
          if (removed.length > 0) {
            ctx.breaking.push({ path: display(path), change: `enum narrowed: removed ${removed.join(', ')}` });
          } else {
            ctx.additive.push({ path: display(path), change: `enum widened: added ${added.join(', ')}` });
          }
        }
        break;
      }
      case 'default':
        if (stable(b) === stable(a)) break;
        ctx.breaking.push({
          path: display(path),
          change: `default ${b === undefined ? 'added' : a === undefined ? 'removed' : 'changed'}: ${b === undefined ? '(none)' : stable(b)} -> ${a === undefined ? '(none)' : stable(a)} (an absent field now means something else)`,
        });
        break;
      case 'additionalProperties':
      case 'unevaluatedProperties': {
        const beforeValue = (b ?? true) as JsonSchema;
        const afterValue = (a ?? true) as JsonSchema;
        if (isObject(beforeValue) && isObject(afterValue)) {
          compareNode(ctx, beforeValue, afterValue, joinProperty(path, '*'));
        } else if (stable(beforeValue) !== stable(afterValue)) {
          if (afterValue === true || beforeValue === false) {
            ctx.additive.push({ path: display(path), change: `${keyword} widened ${stable(beforeValue)} -> ${stable(afterValue)}` });
          } else {
            ctx.breaking.push({ path: display(path), change: `${keyword} narrowed ${stable(beforeValue)} -> ${stable(afterValue)}` });
          }
        }
        break;
      }
      case 'items':
      case 'additionalItems':
      case 'unevaluatedItems':
        compareNode(ctx, (b ?? true) as JsonSchema, (a ?? true) as JsonSchema, `${path}[]`);
        break;
      case 'anyOf':
      case 'oneOf':
        if (Array.isArray(b) && Array.isArray(a)) {
          compareUnion(ctx, keyword, b as JsonSchema[], a as JsonSchema[], path);
        } else if (a === undefined) {
          ctx.additive.push({ path: display(path), change: `${keyword} removed (widened)` });
        } else {
          ctx.breaking.push({ path: display(path), change: `${keyword} ${b === undefined ? 'added' : 'changed'}` });
        }
        break;
      case 'allOf':
      case 'prefixItems':
        if (Array.isArray(b) && Array.isArray(a) && b.length === a.length) {
          b.forEach((branch, index) => compareNode(ctx, branch as JsonSchema, a[index] as JsonSchema, `${path}<${keyword}:${index}>`));
        } else if (stable(b) !== stable(a)) {
          ctx.breaking.push({ path: display(path), change: `${keyword} changed` });
        }
        break;
      case 'uniqueItems':
        if (stable(b) === stable(a)) break;
        (a !== true ? ctx.additive : ctx.breaking).push({
          path: display(path),
          change: `uniqueItems ${stable(b ?? false)} -> ${stable(a ?? false)}`,
        });
        break;
      default:
        if (LOWER_BOUNDS.has(keyword) || UPPER_BOUNDS.has(keyword)) {
          if (stable(b) !== stable(a)) compareBound(ctx, keyword, b, a, path);
        } else if (DROPPABLE_CONSTRAINTS.has(keyword)) {
          if (stable(b) === stable(a)) break;
          if (a === undefined) ctx.additive.push({ path: display(path), change: `${keyword} ${stable(b)} removed (widened)` });
          else ctx.breaking.push({ path: display(path), change: `${keyword} ${b === undefined ? 'added' : 'changed'}: ${stable(b)} -> ${stable(a)}` });
        } else if (SUBSCHEMA_SINGLES.has(keyword) && (isObject(b) || typeof b === 'boolean') && (isObject(a) || typeof a === 'boolean')) {
          compareNode(ctx, b as JsonSchema, a as JsonSchema, `${path}<${keyword}>`);
        } else if (stable(b) !== stable(a)) {
          // Unknown to this classifier: conservatively breaking.
          ctx.breaking.push({ path: display(path), change: `keyword ${keyword} ${b === undefined ? 'added' : a === undefined ? 'removed' : 'changed'}` });
        }
    }
  }
}

/**
 * Classify every difference between two schemas.
 *
 * @param ignoreRootProperties Root properties to skip; the contract check
 *   passes `scenarioVersion`, whose change is the bump itself.
 */
export function diffJsonSchemas(
  before: JsonSchema,
  after: JsonSchema,
  options: { readonly ignoreRootProperties?: readonly string[] } = {},
): SchemaDiff {
  const ctx: DiffContext = {
    beforeRoot: before,
    afterRoot: after,
    seenRefPairs: new Set(),
    additive: [],
    breaking: [],
    ignoreRootProperties: new Set(options.ignoreRootProperties ?? []),
  };
  compareNode(ctx, before, after, '');
  return { additive: ctx.additive, breaking: ctx.breaking };
}
