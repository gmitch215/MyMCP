import { HTTP_METHODS } from '../types';
import type {
	JsonSchema,
	OpenAPI,
	OpenAPIOperation,
	OpenAPIParameter,
	OpenAPIPathItem,
	SecurityScheme
} from '../types';

const REF_MAP: Record<string, string> = {
	'#/definitions/': '#/components/schemas/',
	'#/parameters/': '#/components/parameters/',
	'#/responses/': '#/components/responses/'
};

/** rewrites Swagger 2.0 pointer roots onto their OpenAPI 3 equivalents */
function rewriteRefs<T>(node: T): T {
	if (Array.isArray(node)) return node.map(rewriteRefs) as unknown as T;
	if (!node || typeof node !== 'object') return node;

	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
		if (key === '$ref' && typeof value === 'string') {
			let ref = value;
			for (const [from, to] of Object.entries(REF_MAP)) {
				if (ref.startsWith(from)) {
					ref = to + ref.slice(from.length);
					break;
				}
			}
			out[key] = ref;
			continue;
		}
		out[key] = rewriteRefs(value);
	}
	return out as T;
}

/** Swagger 2.0 put type/format directly on the parameter; OpenAPI 3 nests them under `schema` */
function parameterSchema(param: Record<string, any>): JsonSchema {
	if (param.schema) return rewriteRefs(param.schema);

	const schema: JsonSchema = {};
	const keys = [
		'type',
		'format',
		'items',
		'enum',
		'default',
		'minimum',
		'maximum',
		'exclusiveMinimum',
		'exclusiveMaximum',
		'minLength',
		'maxLength',
		'pattern',
		'minItems',
		'maxItems',
		'uniqueItems',
		'multipleOf'
	];
	for (const key of keys) {
		if (param[key] !== undefined) schema[key] = rewriteRefs(param[key]);
	}
	return Object.keys(schema).length > 0 ? schema : { type: 'string' };
}

function collectionFormatStyle(
	format: string | undefined,
	location: string
): {
	style?: string;
	explode?: boolean;
} {
	switch (format) {
		case 'ssv':
			return { style: 'spaceDelimited', explode: false };
		case 'pipes':
			return { style: 'pipeDelimited', explode: false };
		case 'multi':
			return { style: 'form', explode: true };
		case 'tsv':
			// no OpenAPI 3 equivalent; csv is the closest representable form
			return { style: location === 'query' ? 'form' : 'simple', explode: false };
		case 'csv':
		default:
			return { style: location === 'query' ? 'form' : 'simple', explode: false };
	}
}

function convertSecurityScheme(def: Record<string, any>): SecurityScheme {
	if (def.type === 'basic') return { type: 'http', scheme: 'basic', description: def.description };

	if (def.type === 'oauth2') {
		const flowName =
			def.flow === 'application'
				? 'clientCredentials'
				: def.flow === 'accessCode'
					? 'authorizationCode'
					: def.flow === 'implicit'
						? 'implicit'
						: 'password';
		return {
			type: 'oauth2',
			description: def.description,
			flows: {
				[flowName]: {
					authorizationUrl: def.authorizationUrl,
					tokenUrl: def.tokenUrl,
					scopes: def.scopes ?? {}
				}
			}
		};
	}

	return {
		type: 'apiKey',
		name: def.name,
		in: def.in,
		description: def.description
	};
}

function buildServers(doc: Record<string, any>): { url: string }[] {
	const basePath = typeof doc.basePath === 'string' ? doc.basePath : '';
	if (typeof doc.host !== 'string' || !doc.host) {
		return basePath ? [{ url: basePath }] : [];
	}

	const schemes: string[] =
		Array.isArray(doc.schemes) && doc.schemes.length ? doc.schemes : ['https'];
	const preferred = schemes.includes('https') ? 'https' : schemes[0];
	return [{ url: `${preferred}://${doc.host}${basePath}` }];
}

function convertOperation(
	raw: Record<string, any>,
	consumes: string[],
	produces: string[]
): OpenAPIOperation {
	const params: OpenAPIParameter[] = [];
	let requestBody: OpenAPIOperation['requestBody'];

	const formParams: Record<string, JsonSchema> = {};
	const formRequired: string[] = [];

	for (const raw0 of (raw.parameters ?? []) as Record<string, any>[]) {
		if (!raw0 || typeof raw0 !== 'object') continue;

		if (typeof raw0.$ref === 'string') {
			params.push(rewriteRefs(raw0) as OpenAPIParameter);
			continue;
		}

		if (raw0.in === 'body') {
			const types = consumes.length ? consumes : ['application/json'];
			requestBody = {
				description: raw0.description,
				required: raw0.required === true,
				content: Object.fromEntries(
					types.map((t) => [t, { schema: rewriteRefs(raw0.schema ?? {}) }])
				)
			};
			continue;
		}

		if (raw0.in === 'formData') {
			if (typeof raw0.name !== 'string') continue;
			formParams[raw0.name] =
				raw0.type === 'file'
					? { type: 'string', format: 'binary', description: raw0.description }
					: { ...parameterSchema(raw0), description: raw0.description };
			if (raw0.required === true) formRequired.push(raw0.name);
			continue;
		}

		if (typeof raw0.name !== 'string' || !raw0.in) continue;

		const style = collectionFormatStyle(raw0.collectionFormat, raw0.in);
		params.push({
			name: raw0.name,
			in: raw0.in,
			description: raw0.description,
			required: raw0.in === 'path' ? true : raw0.required === true,
			schema: parameterSchema(raw0),
			...(raw0.type === 'array' ? style : {})
		});
	}

	if (Object.keys(formParams).length > 0) {
		const isMultipart = consumes.some((c) => c.includes('multipart'));
		const mediaType = isMultipart ? 'multipart/form-data' : 'application/x-www-form-urlencoded';
		requestBody = {
			required: formRequired.length > 0,
			content: {
				[mediaType]: {
					schema: {
						type: 'object',
						properties: formParams,
						...(formRequired.length ? { required: formRequired } : {})
					}
				}
			}
		};
	}

	const responses: OpenAPIOperation['responses'] = {};
	for (const [code, rawResponse] of Object.entries((raw.responses ?? {}) as Record<string, any>)) {
		if (!rawResponse || typeof rawResponse !== 'object') continue;
		if (typeof rawResponse.$ref === 'string') {
			responses[code] = rewriteRefs(rawResponse);
			continue;
		}
		const types = produces.length ? produces : ['application/json'];
		responses[code] = {
			description: rawResponse.description ?? '',
			...(rawResponse.schema
				? {
						content: Object.fromEntries(
							types.map((t) => [t, { schema: rewriteRefs(rawResponse.schema) }])
						)
					}
				: {})
		};
	}

	return {
		operationId: raw.operationId,
		summary: raw.summary,
		description: raw.description,
		tags: raw.tags,
		deprecated: raw.deprecated,
		parameters: params.length ? params : undefined,
		requestBody,
		responses,
		security: raw.security
	};
}

/**
 * Converts a Swagger 2.0 document into an equivalent OpenAPI 3.0 document.
 * Returns the input untouched when it is not Swagger 2.0.
 */
export function convertSwagger2(input: unknown): OpenAPI {
	const doc = input as Record<string, any>;
	if (!doc || typeof doc !== 'object' || typeof doc.swagger !== 'string') {
		return input as OpenAPI;
	}

	const globalConsumes: string[] = Array.isArray(doc.consumes) ? doc.consumes : [];
	const globalProduces: string[] = Array.isArray(doc.produces) ? doc.produces : [];

	const paths: Record<string, OpenAPIPathItem> = {};
	for (const [path, rawItem] of Object.entries((doc.paths ?? {}) as Record<string, any>)) {
		if (!rawItem || typeof rawItem !== 'object') continue;

		const item: OpenAPIPathItem = {};

		if (Array.isArray(rawItem.parameters)) {
			const shared = rawItem.parameters
				.filter((p: any) => p && typeof p === 'object' && p.in !== 'body' && p.in !== 'formData')
				.map((p: any) =>
					typeof p.$ref === 'string'
						? rewriteRefs(p)
						: {
								name: p.name,
								in: p.in,
								description: p.description,
								required: p.in === 'path' ? true : p.required === true,
								schema: parameterSchema(p),
								...(p.type === 'array' ? collectionFormatStyle(p.collectionFormat, p.in) : {})
							}
				);
			if (shared.length) item.parameters = shared as OpenAPIParameter[];
		}

		for (const method of HTTP_METHODS) {
			const raw = rawItem[method];
			if (!raw || typeof raw !== 'object') continue;
			const consumes = Array.isArray(raw.consumes) ? raw.consumes : globalConsumes;
			const produces = Array.isArray(raw.produces) ? raw.produces : globalProduces;
			item[method] = convertOperation(raw, consumes, produces);
		}

		paths[path] = item;
	}

	const securitySchemes: Record<string, SecurityScheme> = {};
	for (const [name, def] of Object.entries(
		(doc.securityDefinitions ?? {}) as Record<string, any>
	)) {
		if (def && typeof def === 'object') securitySchemes[name] = convertSecurityScheme(def);
	}

	const globalParams: Record<string, OpenAPIParameter> = {};
	for (const [name, param] of Object.entries((doc.parameters ?? {}) as Record<string, any>)) {
		if (!param || typeof param !== 'object') continue;
		if (param.in === 'body' || param.in === 'formData') continue;
		globalParams[name] = {
			name: param.name,
			in: param.in,
			description: param.description,
			required: param.in === 'path' ? true : param.required === true,
			schema: parameterSchema(param),
			...(param.type === 'array' ? collectionFormatStyle(param.collectionFormat, param.in) : {})
		};
	}

	const globalResponses: Record<string, any> = {};
	for (const [name, response] of Object.entries((doc.responses ?? {}) as Record<string, any>)) {
		if (!response || typeof response !== 'object') continue;
		const types = globalProduces.length ? globalProduces : ['application/json'];
		globalResponses[name] = {
			description: response.description ?? '',
			...(response.schema
				? {
						content: Object.fromEntries(
							types.map((t) => [t, { schema: rewriteRefs(response.schema) }])
						)
					}
				: {})
		};
	}

	return {
		openapi: '3.0.3',
		info: {
			title: doc.info?.title ?? 'API',
			description: doc.info?.description,
			version: doc.info?.version
		},
		servers: buildServers(doc),
		security: doc.security,
		tags: doc.tags,
		components: {
			schemas: rewriteRefs((doc.definitions ?? {}) as Record<string, JsonSchema>),
			parameters: Object.keys(globalParams).length ? globalParams : undefined,
			responses: Object.keys(globalResponses).length ? globalResponses : undefined,
			securitySchemes: Object.keys(securitySchemes).length ? securitySchemes : undefined
		},
		paths
	};
}
