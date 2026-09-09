import type { JsonSchema, ToolDefinition } from '../types';

export type ElicitationMode = 'form' | 'url';

export interface InputRequest {
	method: string;
	params: Record<string, unknown>;
}

export interface InputRequiredResult {
	resultType: 'input_required';
	inputRequests?: Record<string, InputRequest>;
	requestState?: string;
}

/** primitives elicitation allows; anything else has no form representation */
const ALLOWED_TYPES = new Set(['string', 'number', 'integer', 'boolean']);

function firstConcreteType(schema: JsonSchema): string | undefined {
	const t = schema.type;
	if (typeof t === 'string') return t;
	if (Array.isArray(t)) return t.find((v) => typeof v === 'string' && v !== 'null');
	return undefined;
}

/**
 * Whether the client declared support for an elicitation mode.
 * An empty `elicitation` object means form mode only, per the backwards-compatibility rule.
 */
export function supportsElicitation(
	capabilities: Record<string, any> | undefined,
	mode: ElicitationMode
): boolean {
	const elicitation = capabilities?.elicitation;
	if (!elicitation || typeof elicitation !== 'object') return false;

	const keys = Object.keys(elicitation);
	if (keys.length === 0) return mode === 'form';
	return elicitation[mode] !== undefined;
}

export function supportsExtension(
	capabilities: Record<string, any> | undefined,
	name: string
): boolean {
	const extensions = capabilities?.extensions;
	return !!extensions && typeof extensions === 'object' && extensions[name] !== undefined;
}

/**
 * Builds a flat, primitives-only schema for the named arguments.
 * Returns undefined when none of them can be represented in an elicitation form.
 */
export function buildElicitationSchema(
	tool: ToolDefinition,
	argNames: string[]
): JsonSchema | undefined {
	const source = (tool.inputSchema.properties ?? {}) as Record<string, JsonSchema>;
	const properties: Record<string, JsonSchema> = {};
	const required: string[] = [];

	for (const name of argNames) {
		const schema = source[name];
		if (!schema || typeof schema !== 'object') continue;

		const type = firstConcreteType(schema);

		if (Array.isArray(schema.enum) && schema.enum.length > 0) {
			properties[name] = {
				type: 'string',
				title: schema.title ?? name,
				...(schema.description ? { description: schema.description } : {}),
				enum: schema.enum.map((v: unknown) => String(v)),
				...(schema.default !== undefined ? { default: String(schema.default) } : {})
			};
			required.push(name);
			continue;
		}

		if (!type || !ALLOWED_TYPES.has(type)) continue;

		const field: JsonSchema = {
			type,
			title: schema.title ?? name,
			...(schema.description ? { description: schema.description } : {})
		};
		for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'default']) {
			if (schema[key] !== undefined) field[key] = schema[key];
		}
		if (
			typeof schema.format === 'string' &&
			['email', 'uri', 'date', 'date-time'].includes(schema.format)
		) {
			field.format = schema.format;
		}

		properties[name] = field;
		required.push(name);
	}

	if (Object.keys(properties).length === 0) return undefined;
	return { type: 'object', properties, required };
}

export function formElicitation(message: string, requestedSchema: JsonSchema): InputRequest {
	return { method: 'elicitation/create', params: { mode: 'form', message, requestedSchema } };
}

export function urlElicitation(message: string, url: string): InputRequest {
	return { method: 'elicitation/create', params: { mode: 'url', message, url } };
}

export function confirmationSchema(summary: string): JsonSchema {
	return {
		type: 'object',
		properties: {
			confirm: {
				type: 'boolean',
				title: 'Confirm',
				description: summary,
				default: false
			}
		},
		required: ['confirm']
	};
}

/** the shape of one entry in the client's `inputResponses` map */
export interface ElicitResult {
	action: 'accept' | 'decline' | 'cancel';
	content?: Record<string, unknown>;
}

export function readElicitResult(value: unknown): ElicitResult | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const action = (value as { action?: unknown }).action;
	if (action !== 'accept' && action !== 'decline' && action !== 'cancel') return undefined;

	const content = (value as { content?: unknown }).content;
	return {
		action,
		content:
			content && typeof content === 'object' ? (content as Record<string, unknown>) : undefined
	};
}
