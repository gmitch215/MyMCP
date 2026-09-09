import type { JsonSchema, OpenAPI } from '../types';

/** keywords whose value is a single subschema */
const SUBSCHEMA_KEYS = [
	'items',
	'not',
	'if',
	'then',
	'else',
	'contains',
	'propertyNames',
	'additionalItems',
	'unevaluatedItems'
] as const;

/** keywords whose value is an array of subschemas */
const SUBSCHEMA_LIST_KEYS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const;

/** keywords whose value is a map of name -> subschema */
const SUBSCHEMA_MAP_KEYS = [
	'properties',
	'patternProperties',
	'definitions',
	'$defs',
	'dependentSchemas'
] as const;

/** budget on emitted nodes per schema; past it, refs are hoisted instead of inlined */
const DEFAULT_NODE_BUDGET = 4000;

const MAX_DESCRIPTION = 2000;

function unescapePointer(segment: string): string {
	return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * Resolves `$ref` pointers within one OpenAPI document, producing self-contained schemas.
 *
 * Non-cyclic references are inlined for the widest client compatibility. References that are
 * cyclic, or that would exceed the node budget, are hoisted into a shared `$defs` block and
 * replaced with a local pointer, so output stays finite and nothing dangles.
 *
 * Never mutates the source document and never throws on a bad reference.
 */
export class SchemaResolver {
	private readonly doc: OpenAPI;
	private readonly defs = new Map<string, JsonSchema>();
	private readonly namesByPointer = new Map<string, string>();
	private readonly usedNames = new Set<string>();
	private readonly budget: number;
	private readonly shared: Set<string>;

	constructor(doc: OpenAPI, budget: number = DEFAULT_NODE_BUDGET) {
		this.doc = doc;
		this.budget = budget;
		this.shared = findSharedRefs(doc);
	}

	/** the shared `$defs` block; attach to any schema that references it */
	defsBlock(): Record<string, JsonSchema> | undefined {
		if (this.defs.size === 0) return undefined;
		return Object.fromEntries(this.defs);
	}

	/** whether any hoisting happened, meaning the caller must attach `defsBlock()` */
	get hasDefs(): boolean {
		return this.defs.size > 0;
	}

	resolve(schema: JsonSchema | undefined): JsonSchema {
		if (!schema || typeof schema !== 'object') return {};
		return this.inline(schema, [], { left: this.budget });
	}

	/** follows a JSON pointer within the document; undefined for anything unresolvable */
	lookup(ref: string): unknown {
		if (typeof ref !== 'string' || !ref.startsWith('#')) return undefined;

		const path = ref.slice(1).replace(/^\//, '');
		if (path === '') return this.doc;

		let cur: unknown = this.doc;
		for (const raw of path.split('/')) {
			if (cur === null || typeof cur !== 'object') return undefined;
			const key = unescapePointer(raw);
			cur = (cur as Record<string, unknown>)[key];
			if (cur === undefined) return undefined;
		}
		return cur;
	}

	private hoistName(ref: string): string {
		const existing = this.namesByPointer.get(ref);
		if (existing) return existing;

		const last = ref.split('/').pop() ?? 'Schema';
		let base = unescapePointer(last).replace(/[^A-Za-z0-9_]/g, '_') || 'Schema';
		if (/^[0-9]/.test(base)) base = `_${base}`;

		let name = base;
		let n = 2;
		while (this.usedNames.has(name)) name = `${base}_${n++}`;

		this.usedNames.add(name);
		this.namesByPointer.set(ref, name);
		return name;
	}

	/** ensures `ref` has a `$defs` entry and returns a pointer to it */
	private hoist(ref: string, stack: string[]): JsonSchema {
		const name = this.hoistName(ref);
		if (!this.defs.has(name)) {
			// reserve first so a self-reference inside the target finds the pointer, not a loop
			this.defs.set(name, {});
			const target = this.lookup(ref);
			const resolved =
				target && typeof target === 'object'
					? this.inline(target as JsonSchema, [...stack, ref], { left: this.budget })
					: {};
			this.defs.set(name, resolved);
		}
		return { $ref: `#/$defs/${name}` };
	}

	private inline(node: JsonSchema, stack: string[], budget: { left: number }): JsonSchema {
		if (!node || typeof node !== 'object' || Array.isArray(node)) return {};

		if (typeof node.$ref === 'string') {
			const ref = node.$ref;
			const siblings = this.siblings(node);

			// a schema reached from many places is stored once rather than copied into each tool
			if (stack.includes(ref) || budget.left <= 0 || this.shared.has(ref)) {
				return this.merge(this.hoist(ref, stack), siblings);
			}

			const target = this.lookup(ref);
			if (!target || typeof target !== 'object') {
				// unresolvable (external file, missing component): permissive rather than fatal
				return this.merge({}, siblings);
			}

			budget.left--;
			const resolved = this.inline(target as JsonSchema, [...stack, ref], budget);
			return this.merge(resolved, siblings);
		}

		budget.left--;
		const out: JsonSchema = {};

		for (const [key, value] of Object.entries(node)) {
			if (value === undefined) continue;

			if ((SUBSCHEMA_KEYS as readonly string[]).includes(key)) {
				if (value && typeof value === 'object' && !Array.isArray(value)) {
					out[key] = this.inline(value as JsonSchema, stack, budget);
				}
				continue;
			}

			if ((SUBSCHEMA_LIST_KEYS as readonly string[]).includes(key)) {
				if (Array.isArray(value)) {
					out[key] = value.map((v) =>
						v && typeof v === 'object' ? this.inline(v as JsonSchema, stack, budget) : {}
					);
				}
				continue;
			}

			if ((SUBSCHEMA_MAP_KEYS as readonly string[]).includes(key)) {
				if (value && typeof value === 'object' && !Array.isArray(value)) {
					const mapped: Record<string, JsonSchema> = {};
					for (const [prop, sub] of Object.entries(value as Record<string, unknown>)) {
						mapped[prop] =
							sub && typeof sub === 'object' ? this.inline(sub as JsonSchema, stack, budget) : {};
					}
					out[key] = mapped;
				}
				continue;
			}

			if (key === 'additionalProperties' || key === 'unevaluatedProperties') {
				out[key] =
					typeof value === 'boolean'
						? value
						: value && typeof value === 'object'
							? this.inline(value as JsonSchema, stack, budget)
							: true;
				continue;
			}

			if (key === 'description' || key === 'title') {
				if (typeof value === 'string') out[key] = sanitizeText(value);
				continue;
			}

			// 3.0 nullable has no 2020-12 equivalent; folded into the type union below
			if (key === 'nullable') continue;
			if (key === 'discriminator' || key === 'xml' || key === 'externalDocs') continue;

			out[key] = value;
		}

		if (node.nullable === true) applyNullable(out);

		return out;
	}

	/** keywords sitting alongside a `$ref`, which 2020-12 allows and 3.1 specs use */
	private siblings(node: JsonSchema): JsonSchema {
		const rest: JsonSchema = {};
		for (const [key, value] of Object.entries(node)) {
			if (key === '$ref' || value === undefined) continue;
			if (key === 'description' || key === 'title') {
				if (typeof value === 'string') rest[key] = sanitizeText(value);
				continue;
			}
			if (key === 'nullable') continue;
			rest[key] = value;
		}
		if (node.nullable === true) applyNullable(rest);
		return rest;
	}

	/** sibling keywords win, being the more specific annotation at the use site */
	private merge(base: JsonSchema, siblings: JsonSchema): JsonSchema {
		if (Object.keys(siblings).length === 0) return base;
		return { ...base, ...siblings };
	}
}

/**
 * Pointers referenced more than once anywhere in the document.
 *
 * Inlining these would copy the same schema into every tool that reaches it, which is what makes
 * a large description expensive: GitHub's grows from 12 MB of JSON to hundreds of megabytes of
 * duplicated tool schemas. Hoisting them keeps one copy.
 */
export function findSharedRefs(doc: OpenAPI): Set<string> {
	const counts = new Map<string, number>();

	const walk = (node: unknown, depth: number): void => {
		if (depth > 64 || !node || typeof node !== 'object') return;

		if (Array.isArray(node)) {
			for (const item of node) walk(item, depth + 1);
			return;
		}

		for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
			if (key === '$ref' && typeof value === 'string') {
				counts.set(value, (counts.get(value) ?? 0) + 1);
			} else {
				walk(value, depth + 1);
			}
		}
	};

	walk(doc, 0);

	const shared = new Set<string>();
	for (const [ref, count] of counts) if (count > 1) shared.add(ref);
	return shared;
}

/** the `$defs` names a schema reaches, transitively */
export function reachableDefs(schema: JsonSchema, defs: Record<string, JsonSchema>): Set<string> {
	const reached = new Set<string>();
	const pending: unknown[] = [schema];

	while (pending.length > 0) {
		const node = pending.pop();
		if (!node || typeof node !== 'object') continue;

		if (Array.isArray(node)) {
			pending.push(...node);
			continue;
		}

		for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
			if (key === '$ref' && typeof value === 'string' && value.startsWith('#/$defs/')) {
				const name = value.slice('#/$defs/'.length);
				if (!reached.has(name) && defs[name]) {
					reached.add(name);
					pending.push(defs[name]);
				}
			} else if (key !== '$defs') {
				pending.push(value);
			}
		}
	}

	return reached;
}

function applyNullable(schema: JsonSchema): void {
	const t = schema.type;
	if (typeof t === 'string') {
		if (t !== 'null') schema.type = [t, 'null'];
	} else if (Array.isArray(t)) {
		if (!t.includes('null')) schema.type = [...t, 'null'];
	}
}

const ESC = String.fromCharCode(27);
const ANSI_ESCAPE = new RegExp(ESC + '\\[[0-9;?]*[ -/]*[@-~]', 'g');

const TAB = 9;
const LF = 10;
const CR = 13;
const SPACE = 32;
const DEL = 127;

/** zero-width, bidi control and other invisible ranges usable to hide injected instructions */
function isInvisible(code: number): boolean {
	if (code >= 0x200b && code <= 0x200f) return true;
	if (code >= 0x202a && code <= 0x202e) return true;
	if (code >= 0x2060 && code <= 0x2064) return true;
	if (code >= 0x2066 && code <= 0x2069) return true;
	return code === 0xfeff;
}

/**
 * Strips control characters and caps length on text lifted out of a third-party document.
 * Spec text reaches model context verbatim, so it is treated as untrusted input.
 */
export function sanitizeText(value: unknown, max: number = MAX_DESCRIPTION): string {
	if (typeof value !== 'string') return '';

	let out = '';
	for (const ch of value.replace(ANSI_ESCAPE, '')) {
		const code = ch.codePointAt(0);
		if (code === undefined) continue;
		if (code === TAB || code === LF || code === CR) {
			out += ch;
			continue;
		}
		if (code < SPACE || code === DEL) continue;
		if (isInvisible(code)) continue;
		out += ch;
	}

	const trimmed = out.trim();
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, max - 3)}...`;
}
