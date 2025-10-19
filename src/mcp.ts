import { Hono } from 'hono';
import {
	findResponseSchema,
	findSchema,
	MCPRequest,
	ModelsResponse,
	OpenAPI,
	OpenAPISchema,
	ToolsResponse
} from './types';
import { toMachineName, normalizeServerPath, executeApiCall } from './util';
import { upgradeWebSocket } from 'hono/cloudflare-workers';

// JSON-RPC 2.0 types
interface JsonRpcRequest {
	jsonrpc: '2.0';
	id?: string | number;
	method: string;
	params?: any;
}

interface JsonRpcResponse {
	jsonrpc: '2.0';
	id: string | number | null;
	result?: any;
	error?: {
		code: number;
		message: string;
		data?: any;
	};
}

interface JsonRpcNotification {
	jsonrpc: '2.0';
	method: string;
	params?: any;
}

export function createMCP(host: string, openapi: OpenAPI) {
	const mcp = new Hono();
	const id = toMachineName(openapi.info.title);

	const models = createModels(openapi);
	const [tools, map, contentTypes] = createTools(openapi);

	// MCP over SSE endpoint - simplified approach
	// The client connects here and the server responds via SSE
	// Client sends messages via POST to /sse (with message in body)
	mcp.all('/sse', async (c) => {
		// Handle POST requests with JSON-RPC messages
		if (c.req.method === 'POST') {
			try {
				const request = await c.req.json<JsonRpcRequest>();

				// Handle different JSON-RPC methods
				switch (request.method) {
					case 'initialize': {
						const response: JsonRpcResponse = {
							jsonrpc: '2.0',
							id: request.id!,
							result: {
								protocolVersion: '2024-11-05',
								capabilities: {
									tools: {},
									resources: {},
									prompts: {}
								},
								serverInfo: {
									name: openapi.info.title,
									version: openapi.info.version || '1.0.0'
								}
							}
						};
						return c.json(response);
					}

					case 'tools/list': {
						const mcpTools = tools.items.map((tool) => ({
							name: tool.id,
							description: tool.description || tool.name,
							inputSchema: tool.parameters || {
								type: 'object',
								properties: {}
							}
						}));

						const response: JsonRpcResponse = {
							jsonrpc: '2.0',
							id: request.id!,
							result: {
								tools: mcpTools
							}
						};
						return c.json(response);
					}

					case 'tools/call': {
						const { name: toolName, arguments: args } = request.params || {};

						if (!toolName || !map[toolName]) {
							const response: JsonRpcResponse = {
								jsonrpc: '2.0',
								id: request.id!,
								error: {
									code: -32602,
									message: 'Tool not found'
								}
							};
							return c.json(response, 404);
						}

						const [method, path] = map[toolName].split(' ');
						const model = models.items[0];
						const serverPath = normalizeServerPath(model.id);

						try {
							const output = await executeApiCall(
								host,
								serverPath,
								method,
								path,
								args || {},
								contentTypes[toolName] || 'application/json',
								openapi.components?.securitySchemes
							);

							const response: JsonRpcResponse = {
								jsonrpc: '2.0',
								id: request.id!,
								result: {
									content: [
										{
											type: 'text',
											text: typeof output === 'string' ? output : JSON.stringify(output, null, 2)
										}
									]
								}
							};
							return c.json(response);
						} catch (error) {
							const response: JsonRpcResponse = {
								jsonrpc: '2.0',
								id: request.id!,
								error: {
									code: -32603,
									message: 'Internal error',
									data: error instanceof Error ? error.message : 'Unknown error'
								}
							};
							return c.json(response, 500);
						}
					}

					case 'resources/list': {
						const response: JsonRpcResponse = {
							jsonrpc: '2.0',
							id: request.id!,
							result: {
								resources: []
							}
						};
						return c.json(response);
					}

					case 'prompts/list': {
						const response: JsonRpcResponse = {
							jsonrpc: '2.0',
							id: request.id!,
							result: {
								prompts: []
							}
						};
						return c.json(response);
					}

					case 'notifications/initialized': {
						// Client notification that it has initialized - no response needed
						return c.body(null, 204);
					}

					default: {
						const response: JsonRpcResponse = {
							jsonrpc: '2.0',
							id: request.id!,
							error: {
								code: -32601,
								message: 'Method not found'
							}
						};
						return c.json(response, 404);
					}
				}
			} catch (error) {
				const response: JsonRpcResponse = {
					jsonrpc: '2.0',
					id: null,
					error: {
						code: -32700,
						message: 'Parse error'
					}
				};
				return c.json(response, 400);
			}
		}

		// Handle GET request - return SSE stream
		return new Response(
			new ReadableStream({
				start(controller) {
					// SSE streams don't close, they stay open
					// Some clients might not need this at all for HTTP transport
				}
			}),
			{
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					Connection: 'keep-alive'
				}
			}
		);
	});

	// Legacy endpoints for backwards compatibility
	mcp.get('/', (c) =>
		c.json({
			type: 'server_description',
			version: openapi.info.version || '1.0.0',
			name: openapi.info.title,
			description: openapi.info.description,
			capabilities: {
				tools: true,
				streaming: true,
				auth: openapi.security ? true : false
			},
			tools: tools['items'],
			endpoints: {
				models: '/models',
				invoke: '/invoke',
				stream: '/stream/:id',
				sse: '/sse',
				mcp: '/sse'
			}
		})
	);

	mcp.get('/models', (c) => c.json(models, 200));

	mcp.get('/tools', (c) => c.json(tools, 200));
	mcp.get(`/tools/${id}`, (c) => c.json(tools, 200));

	mcp.post('/invoke', async (c) => {
		const invocationData = await c.req.json<MCPRequest>();

		const model = invocationData.model || models.items[0]?.id;
		const { tool, parameters } = invocationData;
		const server = models.items.find((m) => m.id === model);
		if (!server) {
			return c.json({ error: 'Model not found' }, 404);
		}

		if (!tool) {
			return c.json({ error: 'Tool not specified' }, 400);
		}

		if (!map[tool]) {
			return c.json({ error: 'Tool not found', availableTools: Object.keys(map) }, 404);
		}

		// Validate required parameters
		const toolDef = tools.items.find((t) => t.id === tool);
		if (toolDef?.parameters?.required) {
			const missingParams = toolDef.parameters.required.filter((param) => !(param in parameters));
			if (missingParams.length > 0) {
				return c.json({ error: 'Missing required parameters', missing: missingParams }, 400);
			}
		}

		const [method, path] = map[tool].split(' ');
		const serverPath = normalizeServerPath(server.id);

		try {
			const output = await executeApiCall(
				host,
				serverPath,
				method,
				path,
				parameters,
				contentTypes[tool] || 'application/json',
				openapi.components?.securitySchemes
			);

			return c.json({
				type: 'data',
				model,
				output
			});
		} catch (error) {
			console.error('API call error:', error);
			return c.json(
				{
					error: 'API call failed',
					message: error instanceof Error ? error.message : 'Unknown error',
					tool,
					model
				},
				500
			);
		}
	});

	mcp.post('/stream', async (c) => {
		const invocationData = await c.req.json<MCPRequest>();

		const model = invocationData.model || models.items[0]?.id;
		const server = models.items.find((m) => m.id === model);
		if (!server) {
			return c.json({ error: 'Model not found' }, 404);
		}

		if (!invocationData.tool) {
			return c.json({ error: 'Tool not specified' }, 400);
		}

		if (!map[invocationData.tool]) {
			return c.json({ error: 'Tool not found' }, 404);
		}

		const taskId = btoa(JSON.stringify(invocationData));
		return c.json({
			type: 'stream_created',
			taskId,
			streamUrl: `/stream/${taskId}`
		});
	});

	mcp.get(
		'/stream/:id',
		upgradeWebSocket((c) => {
			const { id } = c.req.param();

			return {
				onOpen(ws: any) {
					console.log(`Stream opened for task ${id}`);

					let invocationData: MCPRequest;
					try {
						const decoded = atob(id);
						invocationData = JSON.parse(decoded);
					} catch (error) {
						ws.send(
							JSON.stringify({
								type: 'event',
								event: 'error',
								data: { message: 'Invalid task ID format' }
							})
						);
						ws.close();
						return;
					}

					const { model, tool, parameters } = invocationData;

					// Validate model
					const server = models.items.find((m) => m.id === model);
					if (!server) {
						ws.send(
							JSON.stringify({
								type: 'event',
								event: 'error',
								data: { message: 'Model not found' }
							})
						);
						ws.close();
						return;
					}

					// Validate tool
					if (!tool || !map[tool]) {
						ws.send(
							JSON.stringify({
								type: 'event',
								event: 'error',
								data: { message: 'Tool not specified or not found' }
							})
						);
						ws.close();
						return;
					}

					// Send initial progress
					ws.send(
						JSON.stringify({
							type: 'event',
							event: 'progress',
							data: { percent: 0, status: 'starting' }
						})
					);

					const [method, path] = map[tool].split(' ');
					const serverPath = normalizeServerPath(server.id);

					// Send progress update
					ws.send(
						JSON.stringify({
							type: 'event',
							event: 'progress',
							data: { percent: 30, status: 'fetching' }
						})
					);

					executeApiCall(
						host,
						serverPath,
						method,
						path,
						parameters,
						contentTypes[tool] || 'application/json',
						openapi.components?.securitySchemes
					)
						.then((output) => {
							ws.send(
								JSON.stringify({
									type: 'event',
									event: 'progress',
									data: { percent: 70, status: 'processing' }
								})
							);
							return output;
						})
						.then((output) => {
							// Send completion event with result
							ws.send(
								JSON.stringify({
									type: 'event',
									event: 'complete',
									data: {
										type: 'data',
										model,
										output
									}
								})
							);
							ws.close();
						})
						.catch((error) => {
							ws.send(
								JSON.stringify({
									type: 'event',
									event: 'error',
									data: {
										message: error instanceof Error ? error.message : 'Unknown error'
									}
								})
							);
							ws.close();
						});
				},
				onMessage(event: any, ws: any) {
					console.log(`Client message for stream ${id}:`, event.data);

					try {
						const message = JSON.parse(event.data.toString());
						if (message.type === 'cancel') {
							ws.send(
								JSON.stringify({
									type: 'event',
									event: 'cancelled',
									data: { message: 'Task cancelled by client' }
								})
							);
							ws.close();
						}
					} catch (error) {
						// Ignore malformed messages
					}
				},
				onClose(ws: any) {
					console.log(`Stream closed for ${id}`);
				},
				onError(ws: any, err: any) {
					console.error('Stream error:', err);
				}
			};
		})
	);

	return mcp;
}

function createModels(openapi: OpenAPI): ModelsResponse {
	const id = toMachineName(openapi.info.title);
	const items = openapi.servers.map((server) => ({
		id: `api:${id}:${server.url}`,
		name: `${openapi.info.title} (${server.url})`,
		description: openapi.info.description,
		capabilities: ['json', 'tools'],
		tools_endpoint: `/tools/${id}`
	}));

	return {
		type: 'list',
		items
	};
}

const validMethods = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'];

function createTools(
	openapi: OpenAPI
): [ToolsResponse, Record<string, string>, Record<string, string>] {
	const toolMap: Record<string, string> = {};
	const contentTypeMap: Record<string, string> = {};

	const items = Object.entries(openapi.paths).flatMap(([path, methods]) => {
		return Object.entries(methods).map(([method, details]) => {
			if (!validMethods.includes(method.toLowerCase())) {
				return null; // Skip invalid HTTP methods
			}

			// Generate fallback operationId if missing
			const operationId =
				details.operationId ||
				`${method}_${path.replace(/[^a-z0-9]/gi, '_').replace(/^_+|_+$/g, '')}`;

			let parameters: Record<string, OpenAPISchema> = {};

			// Determine content type
			let contentType = 'application/json';
			if (details.requestBody && 'content' in details.requestBody) {
				const content = details.requestBody.content!;
				contentType = Object.keys(content)[0] || 'application/json';

				if (content['application/json'] && content['application/json'].schema) {
					const schema = findSchema(openapi, content['application/json'].schema);
					parameters['body'] = schema;
				}
			}

			contentTypeMap[operationId] = contentType;

			if (details.parameters) {
				for (const param of details.parameters) {
					const name = `${param.in}-${param.name}`;
					const schema = findSchema(openapi, param.schema);

					parameters[name] = {
						description: param.description || '',
						...schema
					};
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
								if (name === 'body' && details.requestBody) {
									return details.requestBody.required || false;
								}
								return false;
							})
						}
					: undefined;

			toolMap[operationId] = `${method.toUpperCase()} ${path}`;

			const returns =
				'responses' in details
					? {
							oneOf: Object.values(details.responses)
								.map((response) => {
									if ('$ref' in response) {
										const content = findResponseSchema(openapi, response.$ref);
										if (content.content) {
											const schemas: OpenAPISchema[] = [];
											for (const contentType in content.content) {
												const contentItem = content.content[contentType];
												if (contentItem.schema) {
													schemas.push({
														description: content.description,
														...findSchema(openapi, contentItem.schema)
													});
												}
											}

											return schemas.length > 0 ? schemas : [{ type: 'null' }];
										}

										return [{ type: 'null' }];
									}

									const schemas: OpenAPISchema[] = [];

									for (const contentType in response.content) {
										const content = response.content[contentType];
										if (content.schema) {
											schemas.push({
												description: response.description,
												...findSchema(openapi, content.schema)
											});
										}
									}

									return schemas.length > 0 ? schemas : [{ type: 'null' }];
								})
								.flat()
						}
					: undefined;

			return {
				id: operationId,
				name: details.summary || `${method.toUpperCase()} ${path}`,
				description: details.description || '',
				parameters: parameters0,
				returns
			};
		});
	});

	return [
		{
			type: 'list',
			items: items.filter((item): item is Exclude<typeof item, null> => item !== null)
		},
		toolMap,
		contentTypeMap
	];
}
