import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env';
import worker from '../../src/index';
import { clearToolTableCache } from '../../src/resolve';
import { mcpHeaders, rpc, stubFetch } from '../helpers';

const SPEC = JSON.stringify({
	openapi: '3.1.0',
	info: { title: 'Demo API', description: 'demo', version: '2.0.0' },
	servers: [{ url: 'https://api.demo.example/v1' }],
	paths: {
		'/pets': {
			get: {
				operationId: 'listPets',
				responses: {
					'200': {
						description: 'ok',
						content: {
							'application/json': { schema: { type: 'array', items: { type: 'string' } } }
						}
					}
				}
			}
		}
	}
});

const SPEC_URL = 'https://api.demo.example/openapi.json';
const MCP = `https://mymcp.test/${encodeURIComponent(SPEC_URL)}/mcp`;

const env: Env = {};
const ctx = {
	waitUntil: () => undefined,
	passThroughOnException: () => undefined
} as unknown as ExecutionContext;

function call(url: string, init: RequestInit = {}): Promise<Response> {
	return worker.fetch(new Request(url, init), env, ctx);
}

function post(body: string, headers: Record<string, string>, url = MCP): Promise<Response> {
	return call(url, { method: 'POST', headers, body });
}

beforeEach(() => {
	clearToolTableCache();
	stubFetch({ [SPEC_URL]: { body: SPEC }, 'https://api.demo.example/v1/pets': { body: '["a"]' } });
});
afterEach(() => clearToolTableCache());

describe('protocol 2026-07-28', () => {
	it('implements server/discover with supported versions and identity', async () => {
		const response = await post(rpc('server/discover'), mcpHeaders('server/discover'));
		const body = (await response.json()) as any;

		expect(response.status).toBe(200);
		expect(body.result.supportedVersions).toContain('2026-07-28');
		expect(body.result.resultType).toBe('complete');
		expect(body.result._meta['io.modelcontextprotocol/serverInfo'].name).toBe('Demo API');
		expect(body.result.capabilities.tools).toBeDefined();
	});

	it('stamps resultType complete on ordinary results', async () => {
		const body = (await (await post(rpc('tools/list'), mcpHeaders('tools/list'))).json()) as any;
		expect(body.result.resultType).toBe('complete');
	});

	it('carries cache hints on list results', async () => {
		const body = (await (await post(rpc('tools/list'), mcpHeaders('tools/list'))).json()) as any;
		expect(body.result.ttlMs).toBeGreaterThan(0);
		expect(body.result.cacheScope).toBe('public');
	});

	it('rejects an unsupported protocol version with the supported list', async () => {
		const response = await post(rpc('tools/list', {}, 1, '1999-01-01'), {
			...mcpHeaders('tools/list'),
			'MCP-Protocol-Version': '1999-01-01'
		});
		const body = (await response.json()) as any;

		expect(response.status).toBe(400);
		expect(body.error.code).toBe(-32022);
		expect(body.error.data.supported).toContain('2026-07-28');
	});

	it('returns 404 with -32601 for an unknown method', async () => {
		const response = await post(rpc('does/notexist'), mcpHeaders('does/notexist'));
		const body = (await response.json()) as any;

		expect(response.status).toBe(404);
		expect(body.error.code).toBe(-32601);
	});

	it('answers a notification with 202 and no body', async () => {
		const body = JSON.stringify({
			jsonrpc: '2.0',
			method: 'notifications/initialized',
			params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } }
		});
		const response = await post(body, mcpHeaders('notifications/initialized'));

		expect(response.status).toBe(202);
		expect(await response.text()).toBe('');
	});
});

describe('header validation', () => {
	it('rejects a protocol version header that disagrees with the body', async () => {
		const response = await post(rpc('tools/list', {}, 1, '2026-07-28'), {
			...mcpHeaders('tools/list'),
			'MCP-Protocol-Version': '2025-06-18'
		});
		const body = (await response.json()) as any;

		expect(response.status).toBe(400);
		expect(body.error.code).toBe(-32020);
	});

	it('rejects an Mcp-Method header that disagrees with the body', async () => {
		const response = await post(rpc('tools/list'), {
			...mcpHeaders('tools/list'),
			'Mcp-Method': 'tools/call'
		});
		const body = (await response.json()) as any;

		expect(response.status).toBe(400);
		expect(body.error.code).toBe(-32020);
	});

	it('rejects an Mcp-Name header that disagrees with the body', async () => {
		const response = await post(rpc('tools/call', { name: 'listPets', arguments: {} }), {
			...mcpHeaders('tools/call', 'somethingElse')
		});
		const body = (await response.json()) as any;

		expect(response.status).toBe(400);
		expect(body.error.code).toBe(-32020);
	});

	it('accepts a base64-encoded Mcp-Name that decodes to the body value', async () => {
		const encoded = `=?base64?${btoa('listPets')}?=`;
		const response = await post(rpc('tools/call', { name: 'listPets', arguments: {} }), {
			...mcpHeaders('tools/call'),
			'Mcp-Name': encoded
		});

		expect(response.status).toBe(200);
	});

	it('requires Mcp-Method on the current protocol version', async () => {
		const headers = mcpHeaders('tools/list');
		delete headers['Mcp-Method'];
		const response = await post(rpc('tools/list'), headers);
		const body = (await response.json()) as any;

		expect(response.status).toBe(400);
		expect(body.error.message).toContain('Mcp-Method');
	});

	it('requires Mcp-Name on a tools/call', async () => {
		const response = await post(
			rpc('tools/call', { name: 'listPets', arguments: {} }),
			mcpHeaders('tools/call')
		);
		const body = (await response.json()) as any;

		expect(response.status).toBe(400);
		expect(body.error.message).toContain('Mcp-Name');
	});
});

describe('legacy protocol eras', () => {
	it('answers initialize for a 2025-06-18 client', async () => {
		const body = JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'x', version: '1' }
			}
		});
		const response = await post(body, {
			'Content-Type': 'application/json',
			'MCP-Protocol-Version': '2025-06-18'
		});
		const parsed = (await response.json()) as any;

		expect(response.status).toBe(200);
		expect(parsed.result.protocolVersion).toBe('2025-06-18');
		expect(parsed.result.serverInfo.name).toBe('Demo API');
		expect(parsed.result.resultType).toBeUndefined();
	});

	it('answers ping for a legacy client', async () => {
		const body = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping', params: {} });
		const response = await post(body, {
			'Content-Type': 'application/json',
			'MCP-Protocol-Version': '2025-06-18'
		});

		expect(((await response.json()) as any).result).toEqual({});
	});

	it('does not require the modern headers from a legacy client', async () => {
		const body = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
		const response = await post(body, {
			'Content-Type': 'application/json',
			'MCP-Protocol-Version': '2025-03-26'
		});

		expect(response.status).toBe(200);
		expect(((await response.json()) as any).result.tools).toHaveLength(1);
	});

	it('answers a batch array from a 2025-03-26 client', async () => {
		const body = JSON.stringify([
			{ jsonrpc: '2.0', id: 1, method: 'ping', params: {} },
			{ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
		]);
		const response = await post(body, {
			'Content-Type': 'application/json',
			'MCP-Protocol-Version': '2025-03-26'
		});
		const parsed = (await response.json()) as any[];

		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed).toHaveLength(2);
		expect(parsed.map((r) => r.id)).toEqual([1, 2]);
	});
});

describe('JSON-RPC edge cases', () => {
	it('echoes a zero id rather than treating it as absent', async () => {
		const response = await post(rpc('tools/list', {}, 0), mcpHeaders('tools/list'));
		const body = (await response.json()) as any;

		expect(body.id).toBe(0);
		expect(body.result).toBeDefined();
	});

	it('handles a string id', async () => {
		const body = (await (
			await post(rpc('tools/list', {}, 'abc'), mcpHeaders('tools/list'))
		).json()) as any;
		expect(body.id).toBe('abc');
	});

	it('handles an explicit null id', async () => {
		const body = (await (
			await post(rpc('tools/list', {}, null), mcpHeaders('tools/list'))
		).json()) as any;
		expect(body.id).toBeNull();
	});

	it('reports a parse error for malformed JSON', async () => {
		const response = await post('{not json', mcpHeaders('tools/list'));
		const body = (await response.json()) as any;

		expect(response.status).toBe(400);
		expect(body.error.code).toBe(-32700);
	});

	it('rejects a message with the wrong jsonrpc version', async () => {
		const body = JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'tools/list' });
		const response = await post(body, mcpHeaders('tools/list'));

		expect(response.status).toBe(400);
		expect(((await response.json()) as any).error.code).toBe(-32600);
	});

	it('rejects a message with no method', async () => {
		const body = JSON.stringify({ jsonrpc: '2.0', id: 1 });
		const response = await post(body, mcpHeaders('tools/list'));

		expect(response.status).toBe(400);
	});
});

describe('transport rules', () => {
	it('returns 405 for GET on the MCP endpoint', async () => {
		const response = await call(MCP, { method: 'GET' });
		expect(response.status).toBe(405);
		expect(response.headers.get('Allow')).toContain('POST');
	});

	it('returns 405 for DELETE on the MCP endpoint', async () => {
		expect((await call(MCP, { method: 'DELETE' })).status).toBe(405);
	});

	it('rejects a disallowed Origin with 403', async () => {
		const response = await post(rpc('tools/list'), {
			...mcpHeaders('tools/list'),
			Origin: 'null'
		});
		expect(response.status).toBe(403);
	});

	it('allows a same-origin request', async () => {
		const response = await post(rpc('tools/list'), {
			...mcpHeaders('tools/list'),
			Origin: 'https://mymcp.test'
		});
		expect(response.status).toBe(200);
	});

	it('ignores a session id header rather than minting one', async () => {
		const response = await post(rpc('tools/list'), {
			...mcpHeaders('tools/list'),
			'Mcp-Session-Id': 'stale-session'
		});

		expect(response.status).toBe(200);
		expect(response.headers.get('Mcp-Session-Id')).toBeNull();
	});

	it('answers CORS preflight', async () => {
		const response = await call(MCP, { method: 'OPTIONS' });
		expect(response.status).toBe(204);
		expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
	});

	it('keeps the POST /sse endpoint working for existing deployments', async () => {
		const url = `https://mymcp.test/${encodeURIComponent(SPEC_URL)}/sse`;
		const response = await post(rpc('tools/list'), { 'Content-Type': 'application/json' }, url);

		expect(response.status).toBe(200);
		expect(((await response.json()) as any).result.tools).toHaveLength(1);
	});

	it('explains that GET /sse needs the Durable Object binding', async () => {
		const url = `https://mymcp.test/${encodeURIComponent(SPEC_URL)}/sse`;
		const response = await call(url, { method: 'GET' });

		expect(response.status).toBe(405);
		expect(JSON.stringify(await response.json())).toContain('/mcp');
	});
});

describe('tools/call', () => {
	it('calls the upstream API and returns its result', async () => {
		const response = await post(
			rpc('tools/call', { name: 'listPets', arguments: {} }),
			mcpHeaders('tools/call', 'listPets')
		);
		const body = (await response.json()) as any;

		expect(body.result.isError).toBeFalsy();
		expect(body.result.content[0].text).toBe('["a"]');
		expect(body.result.structuredContent).toEqual(['a']);
	});

	it('reports an unknown tool as an invalid-params error', async () => {
		const response = await post(
			rpc('tools/call', { name: 'nope', arguments: {} }),
			mcpHeaders('tools/call', 'nope')
		);
		const body = (await response.json()) as any;

		expect(body.error.code).toBe(-32602);
		expect(body.error.data.available).toContain('listPets');
	});
});

describe('prompts and resources', () => {
	it('lists a prompt per tool', async () => {
		const body = (await (
			await post(rpc('prompts/list'), mcpHeaders('prompts/list'))
		).json()) as any;
		expect(body.result.prompts.map((p: { name: string }) => p.name)).toEqual(['listPets']);
	});

	it('returns a prompt that names the operation', async () => {
		const response = await post(
			rpc('prompts/get', { name: 'listPets', arguments: {} }),
			mcpHeaders('prompts/get', 'listPets')
		);
		const body = (await response.json()) as any;
		expect(body.result.messages[0].content.text).toContain('GET /pets');
	});

	it('exposes the description as a readable resource', async () => {
		const listed = (await (
			await post(rpc('resources/list'), mcpHeaders('resources/list'))
		).json()) as any;
		const uri = listed.result.resources[0].uri;

		const read = (await (
			await post(rpc('resources/read', { uri }), mcpHeaders('resources/read', uri))
		).json()) as any;

		expect(JSON.parse(read.result.contents[0].text).toolCount).toBe(1);
	});

	it('returns an empty template list', async () => {
		const body = (await (
			await post(rpc('resources/templates/list'), mcpHeaders('resources/templates/list'))
		).json()) as any;
		expect(body.result.resourceTemplates).toEqual([]);
	});

	it('rejects an unknown prompt', async () => {
		const response = await post(
			rpc('prompts/get', { name: 'nope' }),
			mcpHeaders('prompts/get', 'nope')
		);
		expect(((await response.json()) as any).error.code).toBe(-32602);
	});

	it('rejects a prompts/get with no name at the header check', async () => {
		const response = await post(rpc('prompts/get', {}), mcpHeaders('prompts/get'));
		expect(((await response.json()) as any).error.code).toBe(-32020);
	});

	it('requires a prompt name once past header validation', async () => {
		const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: {} });
		const response = await post(body, {
			'Content-Type': 'application/json',
			'MCP-Protocol-Version': '2025-06-18'
		});
		expect(((await response.json()) as any).error.code).toBe(-32602);
	});

	it('rejects an unknown resource uri', async () => {
		const response = await post(
			rpc('resources/read', { uri: 'openapi://elsewhere' }),
			mcpHeaders('resources/read', 'openapi://elsewhere')
		);
		expect(((await response.json()) as any).error.code).toBe(-32602);
	});

	it('requires a resource uri once past header validation', async () => {
		const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: {} });
		const response = await post(body, {
			'Content-Type': 'application/json',
			'MCP-Protocol-Version': '2025-06-18'
		});
		expect(((await response.json()) as any).error.code).toBe(-32602);
	});
});

describe('pagination', () => {
	it('accepts an absent cursor as the first page', async () => {
		const body = (await (
			await post(rpc('tools/list', {}), mcpHeaders('tools/list'))
		).json()) as any;
		expect(body.result.tools).toHaveLength(1);
		expect(body.result.nextCursor).toBeUndefined();
	});

	it('rejects a malformed cursor', async () => {
		const response = await post(
			rpc('tools/list', { cursor: 'not-a-cursor!!' }),
			mcpHeaders('tools/list')
		);
		expect(((await response.json()) as any).error.code).toBe(-32602);
	});

	it('rejects a non-string cursor', async () => {
		const response = await post(rpc('tools/list', { cursor: 5 }), mcpHeaders('tools/list'));
		expect(((await response.json()) as any).error.code).toBe(-32602);
	});

	it('rejects a malformed cursor on prompts/list', async () => {
		const response = await post(rpc('prompts/list', { cursor: '!!' }), mcpHeaders('prompts/list'));
		expect(((await response.json()) as any).error.code).toBe(-32602);
	});
});

describe('completion/complete', () => {
	it('offers enum values for a tool argument', async () => {
		clearToolTableCache();
		stubFetch({
			[SPEC_URL]: {
				body: JSON.stringify({
					openapi: '3.1.0',
					info: { title: 'Demo API', description: 'demo', version: '1.0.0' },
					servers: [{ url: 'https://api.demo.example/v1' }],
					paths: {
						'/pets': {
							get: {
								operationId: 'findPets',
								parameters: [
									{
										name: 'status',
										in: 'query',
										schema: { type: 'string', enum: ['available', 'pending', 'sold'] }
									}
								],
								responses: {}
							}
						}
					}
				})
			}
		});

		const body = (await (
			await post(
				rpc('completion/complete', {
					ref: { type: 'ref/prompt', name: 'findPets' },
					argument: { name: 'status', value: 'p' }
				}),
				mcpHeaders('completion/complete')
			)
		).json()) as any;

		expect(body.result.completion.values).toEqual(['pending']);
	});

	it('returns nothing for an unknown tool or argument', async () => {
		const empty = (await (
			await post(
				rpc('completion/complete', {
					ref: { type: 'ref/prompt', name: 'nope' },
					argument: { name: 'x', value: '' }
				}),
				mcpHeaders('completion/complete')
			)
		).json()) as any;
		expect(empty.result.completion.values).toEqual([]);
	});

	it('returns nothing when the request omits a ref', async () => {
		const body = (await (
			await post(rpc('completion/complete', {}), mcpHeaders('completion/complete'))
		).json()) as any;
		expect(body.result.completion.total).toBe(0);
	});
});
