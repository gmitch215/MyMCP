// MCP

export interface MCPRequest {
	model: string;
	tool?: string;
	parameters: {
		[paramName: string]: any;
	};
}

export interface MCPResponse {
	type: string;
}

export interface ModelsResponse extends MCPResponse {
	items: {
		id: string;
		name: string;
		description: string;
		capabilities: string[];
		tools_endpoint?: string;
	}[];
}

export interface ToolsResponse extends MCPResponse {
	items: {
		id: string;
		name: string;
		description: string;
		parameters?: {
			type: string;
			properties: {
				[paramName: string]: OpenAPISchema;
			};
			required?: string[];
		};
		returns?: any;
	}[];
}

export interface Prompt {
	name: string;
	description?: string;
	arguments?: {
		name: string;
		description?: string;
		required?: boolean;
	}[];
}

export interface PromptsResponse extends MCPResponse {
	items: Prompt[];
}

// JSON-RPC 2.0 types
export interface JsonRpcRequest {
	jsonrpc: '2.0';
	id?: string | number;
	method: string;
	params?: any;
}

export interface JsonRpcResponse {
	jsonrpc: '2.0';
	id: string | number | null;
	result?: any;
	error?: {
		code: number;
		message: string;
		data?: any;
	};
	method?: string;
}

export interface JsonRpcNotification {
	jsonrpc: '2.0';
	method: string;
	params?: any;
}

// OpenAPI

export interface OpenAPI {
	openapi: string;
	servers: {
		url: string;
	}[];
	info: {
		title: string;
		description: string;
		version?: string;
		license?: {
			name: string;
			url: string;
		};
	};
	security?: Array<Record<string, string[]>>;
	components?: {
		schemas?: {
			[name: string]: OpenAPISchema;
		};
		responses?: {
			[name: string]: {
				description: string;
				content?: {
					[contentType: string]: {
						schema: OpenAPISchema;
					};
				};
			};
		};
		securitySchemes?: {
			[name: string]: {
				type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect';
				name?: string;
				in?: 'query' | 'header' | 'cookie';
				scheme?: string;
				bearerFormat?: string;
			};
		};
	};
	paths: {
		[path: string]: {
			[M in OpenAPIMethod]?: {
				summary?: string;
				operationId: string;
				description?: string;
				parameters?: OpenAPIParameter[];
				requestBody?: {
					description?: string;
					required: boolean;
					content?: {
						[contentType: string]: {
							schema: OpenAPISchema;
						};
					};
				};
				responses: {
					[statusCode: string]:
						| {
								description: string;
								content?: {
									[contentType: string]: {
										schema: OpenAPISchema;
									};
								};
						  }
						| { $ref: string };
				};
			};
		};
	};
}

export type OpenAPIType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'integer' | 'null';
export type OpenAPIMethod = 'get' | 'post' | 'put' | 'delete' | 'patch' | 'options' | 'head';
export type OpenAPIParameterIn = 'query' | 'header' | 'path' | 'cookie';

export interface OpenAPIParameter {
	name: string;
	in: OpenAPIParameterIn;
	description?: string;
	required: boolean;
	schema: OpenAPISchema;
}

export type OpenAPISchemaFull = (
	| {
			type: 'object';
			properties?: {
				[propName: string]: OpenAPISchema;
			};
			required?: string[];
	  }
	| { type: 'array'; items: OpenAPISchema }
	| { type: 'string'; enum?: string[] }
	| { type: 'number' | 'integer'; minimum?: number; maximum?: number }
	| { type: 'boolean' }
	| { type: 'null' }
) & { description?: string };

export type OpenAPISchema = OpenAPISchemaFull | { $ref: string };

/**
 * Helper function to resolve $defs references with ambiguity detection
 * Supports:
 * - Local: #/$defs/DefName within the current schema context
 * - Root-level: #/$defs/DefName (OpenAPI 3.1 root $defs)
 * - Exact: #/components/schemas/SchemaName/$defs/DefName
 * - Bare search: #/$defs/DefName (searches all component schemas if not in root)
 */
function resolveDefsReference(openapi: OpenAPI, ref: string, localSchema?: any): any | null {
	const comps = openapi.components?.schemas || {};

	if (ref.startsWith('#/components/schemas/')) {
		const remainder = ref.replace('#/components/schemas/', '');
		const schemaMatch = remainder.match(/^([^/]+)\/\$defs\/(.+)$/);
		if (schemaMatch) {
			const [, schemaName, defPath] = schemaMatch;
			const schema = comps[schemaName];
			if (schema && typeof schema === 'object' && '$defs' in schema) {
				let cur: any = (schema as any).$defs;
				for (const part of defPath.split('/')) {
					if (cur && part in cur) {
						cur = cur[part];
					} else {
						return null;
					}
				}
				return cur;
			}
		}
	}

	if (ref.startsWith('#/$defs/')) {
		const defPath = ref.replace('#/$defs/', '').split('/');

		// First, check local schema context (same schema that contains the $ref)
		if (localSchema && typeof localSchema === 'object' && localSchema.$defs) {
			let cur: any = localSchema.$defs;
			let matched = true;
			for (const part of defPath) {
				if (cur && part in cur) {
					cur = cur[part];
				} else {
					matched = false;
					break;
				}
			}
			if (matched && cur) {
				return cur;
			}
		}

		const openapiAny = openapi as any;
		if (openapiAny.$defs) {
			let cur: any = openapiAny.$defs;
			let matched = true;
			for (const part of defPath) {
				if (cur && part in cur) {
					cur = cur[part];
				} else {
					matched = false;
					break;
				}
			}
			if (matched && cur) {
				return cur;
			}
		}

		// If not found at root, search component schemas
		const matches: Array<{ schemaName: string; def: any }> = [];
		for (const schemaName of Object.keys(comps)) {
			const node: any = comps[schemaName];
			if (!node || typeof node !== 'object' || !node.$defs) continue;

			let cur: any = node.$defs;
			let matched = true;
			for (const part of defPath) {
				if (cur && part in cur) {
					cur = cur[part];
				} else {
					matched = false;
					break;
				}
			}
			if (matched && cur) {
				matches.push({ schemaName, def: cur });
			}
		}

		if (matches.length === 0) {
			return null;
		}

		if (matches.length > 1) {
			const schemaNames = matches.map((m) => m.schemaName).join(', ');
			console.warn(
				`Ambiguous $defs reference "${ref}" found in multiple schemas: ${schemaNames}. Using first match from "${matches[0].schemaName}". Consider using explicit reference: #/components/schemas/${matches[0].schemaName}/$defs/${defPath.join('/')}`
			);
		}

		return matches[0].def;
	}

	return null;
}

export function findResponseSchema(
	openapi: OpenAPI,
	ref: string
): Exclude<
	NonNullable<OpenAPI['paths'][string][OpenAPIMethod]>['responses'][string],
	{ $ref: string }
> {
	if (ref.startsWith('#/components/responses/')) {
		const response = openapi.components!.responses![ref.replace('#/components/responses/', '')];
		if (response.content) {
			for (const [key, schemaObj] of Object.entries(response.content)) {
				if ('$ref' in schemaObj.schema) {
					response.content[key].schema = findSchema(openapi, schemaObj.schema);
				}
			}
		}

		return response;
	}

	// Try resolving as a $defs reference
	const defsResult = resolveDefsReference(openapi, ref);
	if (defsResult) {
		return defsResult as any;
	}

	throw new Error(`Unsupported $ref format: ${ref}`);
}

export function findSchema(
	openapi: OpenAPI,
	schema: OpenAPISchema,
	rootSchema?: any
): OpenAPISchemaFull {
	const contextSchema =
		rootSchema || (schema && typeof schema === 'object' && '$defs' in schema ? schema : undefined);

	if ('$ref' in schema) {
		const ref = schema.$ref;

		if (ref.startsWith('#/components/schemas/') && !ref.includes('/$defs/')) {
			const schemaName = ref.replace('#/components/schemas/', '');
			return openapi.components!.schemas![schemaName] as OpenAPISchemaFull;
		}

		const defsResult = resolveDefsReference(openapi, ref, contextSchema);
		if (defsResult) {
			if (defsResult.$ref) {
				return findSchema(openapi, defsResult, contextSchema);
			}

			return defsResult as OpenAPISchemaFull;
		}

		throw new Error(`Unsupported $ref format: ${ref}`);
	}

	if (schema.type === 'object' && schema.properties) {
		const resolvedProperties: Record<string, OpenAPISchema> = {};
		for (const [propName, propSchema] of Object.entries(schema.properties)) {
			if ('$ref' in propSchema) {
				resolvedProperties[propName] = findSchema(openapi, propSchema, contextSchema);
			} else {
				resolvedProperties[propName] = propSchema;
			}
		}

		return {
			...schema,
			properties: resolvedProperties
		};
	}

	if (schema.type === 'array' && '$ref' in schema.items) {
		return {
			...schema,
			items: findSchema(openapi, schema.items, contextSchema)
		};
	}

	return schema;
}
