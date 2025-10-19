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

	throw new Error(`Unsupported $ref format: ${ref}`);
}

export function findSchema(openapi: OpenAPI, schema: OpenAPISchema): OpenAPISchemaFull {
	if ('$ref' in schema) {
		return openapi.components!.schemas![
			schema.$ref.replace('#/components/schemas/', '')
		] as OpenAPISchemaFull;
	}

	if (schema.type === 'object' && schema.properties) {
		const resolvedProperties: Record<string, OpenAPISchema> = {};
		for (const [propName, propSchema] of Object.entries(schema.properties)) {
			if ('$ref' in propSchema) {
				resolvedProperties[propName] = findSchema(openapi, propSchema);
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
			items: findSchema(openapi, schema.items)
		};
	}

	return schema;
}
