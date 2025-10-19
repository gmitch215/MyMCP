import { Hono } from 'hono';
import { findSchema, ModelsResponse, OpenAPI, OpenAPISchema, ToolsResponse } from './types';
import { toMachineName } from './util';

export function createMCP(openapi: OpenAPI) {
	const mcp = new Hono();

	const models = createModels(openapi);
	mcp.get('/models', (c) => c.json(models, 200));

	return mcp;
}

function createModels(openapi: OpenAPI): ModelsResponse {
	const id = toMachineName(openapi.info.title);
	const items = openapi.servers.map((server) => ({
		id: `api:${id}${server}`,
		name: `${openapi.info.title} (${server})`,
		description: openapi.info.description,
		capabilities: ['json', 'tools'],
		tools_endpoint: `/tools/${id}`
	}));

	return {
		type: 'list',
		items
	};
}

function createTools(openapi: OpenAPI): ToolsResponse {
	const items = Object.entries(openapi.paths).flatMap(([path, methods]) => {
		return Object.entries(methods).map(([method, details]) => {
			let parameters: Record<string, OpenAPISchema> = {};

			if (details.requestBody && 'content' in details.requestBody) {
				const content = details.requestBody.content!;

				if (content['application/json'] && content['application/json'].schema) {
					const schema = findSchema(openapi, content['application/json'].schema);
					parameters['body'] = schema;
				}
			}

			if (details.parameters) {
				for (const param of details.parameters) {
					const name = `${param.in}-${param.name}`;
					const schema = findSchema(openapi, param.schema);

					parameters[name] = schema;
				}
			}

			const parameters0 =
				Object.keys(parameters).length > 0
					? {
							type: 'object',
							properties: parameters,
							required: Object.keys(parameters).filter((name) => {
								if (details.parameters) {
									const param = details.parameters.find((p) => `${p.in}-${p.name}` === name);
									return param ? param.required : false;
								}
								return false;
							})
						}
					: undefined;

			return {
				id: details.operationId || toMachineName(`${method} ${path}`),
				name: details.summary || `${method.toUpperCase()} ${path}`,
				description: details.description || '',
				parameters: parameters0
			};
		});
	});

	return {
		type: 'list',
		items
	};
}
