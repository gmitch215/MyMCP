// MCP

export interface MCPRequest {
	model: string;
	tool?: string;
	parameters: {
		[paramName: string]: any;
		options?: {
			include_summary?: boolean;
			format?: 'text' | 'json';
		};
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
	}[];
}

// OpenAPI

export interface OpenAPI {
	servers: {
		url: string;
	}[];
	info: {
		title: string;
		description: string;
		license?: {
			name: string;
			url: string;
		};
	};
	components?: {
		schemas?: {
			[name: string]: OpenAPISchema;
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
					[statusCode: string]: {
						description: string;
						content?: {
							[contentType: string]: {
								schema: OpenAPISchema;
							};
						};
					};
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

export type OpenAPIProperty =
	| ((
			| {
					type: 'string';
					enum?: string[];
			  }
			| {
					type: 'number' | 'integer';
					minimum?: number;
					maximum?: number;
			  }
			| {
					type: 'boolean';
			  }
			| {
					type: 'array';
					items: {
						$ref?: string;
						type?: OpenAPIType;
					};
			  }
			| {
					type: 'array';
					items: Record<string, OpenAPISchema>;
			  }
			| { type: 'object'; properties?: Record<string, OpenAPISchema> }
			| { type: 'null' }
	  ) & { description?: string; nullable?: boolean; default?: any; example?: any })
	| {
			$ref: string;
	  };

export type OpenAPISchemaFull = (
	| {
			type: 'object';
			properties?: {
				[propName: string]: OpenAPIProperty;
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

export function findSchema(openapi: OpenAPI, schema: OpenAPISchema): OpenAPISchemaFull {
	if ('$ref' in schema) {
		return openapi.components!.schemas![
			schema.$ref.replace('#/components/schemas/', '')
		] as OpenAPISchemaFull;
	}

	return schema;
}
