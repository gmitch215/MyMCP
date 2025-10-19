import { Hono } from 'hono';
import {
	findSchema,
	MCPRequest,
	ModelsResponse,
	OpenAPI,
	OpenAPISchema,
	ToolsResponse
} from './types';
import { toMachineName } from './util';

export function createMCP(host: string, openapi: OpenAPI) {
	const mcp = new Hono();
	const id = toMachineName(openapi.info.title);

	const models = createModels(openapi);
	mcp.get('/models', (c) => c.json(models, 200));

	const [tools, map] = createTools(openapi);
	mcp.get(`/tools/${id}`, (c) => c.json(tools, 200));

	mcp.post('/invoke', async (c) => {
		const { model, tool, parameters } = await c.req.json<MCPRequest>();
		if (!model) {
			return c.json({ error: 'Model not specified' }, 400);
		}

		const server = models.items.find((m) => m.id === model);
		if (!server) {
			return c.json({ error: 'Model not found' }, 404);
		}

		let server0 = server.id.split(':')[2];
		if (!server0.startsWith('/')) {
			server0 = `/${server0}`;
		}

		if (!server0.endsWith('/')) {
			server0 = `${server0}/`;
		}

		if (!tool) {
			return c.json({ error: 'Tool not specified' }, 400);
		}

		const [method, path] = map[tool].split(' ');

		let body: any = null;
		if (parameters.body) {
			body = parameters.body;
			delete parameters.body;
		}

		const queryParameters = new URLSearchParams();
		const pathParameters = new Map<string, string>();

		for (const [key, value] of Object.entries(parameters)) {
			if (key.startsWith('query-')) {
				queryParameters.append(key.substring(6), String(value));
			} else if (key.startsWith('path-')) {
				pathParameters.set(key.substring(5), String(value));
			}
		}

		const path0 = Array.from(pathParameters.entries()).reduce((prev, [key, value]) => {
			return prev
				.replace(`{${key}}`, encodeURIComponent(value))
				.replace(`:${key}`, encodeURIComponent(value));
		}, path);

		const url =
			queryParameters.toString().length > 0
				? `https://${host}${server0}${path0}?${queryParameters.toString()}`
				: `https://${host}${server0}${path0}`;

		const res = await fetch(url, {
			method,
			headers: {
				'Content-Type': 'application/json'
			},
			body
		});
	});

	return mcp;
}

function createModels(openapi: OpenAPI): ModelsResponse {
	const id = toMachineName(openapi.info.title);
	const items = openapi.servers.map((server) => ({
		id: `api:${id}:${server}`,
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

function createTools(openapi: OpenAPI): [ToolsResponse, Record<string, string>] {
	const toolMap: Record<string, string> = {};

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

			toolMap[details.operationId] = `${method.toUpperCase()} ${path}`;

			return {
				id: details.operationId,
				name: details.summary || `${method.toUpperCase()} ${path}`,
				description: details.description || '',
				parameters: parameters0
			};
		});
	});

	return [
		{
			type: 'list',
			items
		},
		{}
	];
}
