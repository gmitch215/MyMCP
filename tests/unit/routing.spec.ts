import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker, { splitPath } from '../../src/index';
import lib from '../../src/lib';
import type { Env } from '../../src/env';
import { allowlistOnly, authEnabled, maxResponseBytes, maxSpecBytes } from '../../src/env';
import { clearToolTableCache } from '../../src/resolve';
import { SCALAR_PAGE, mcpHeaders, rpc, stubFetch } from '../helpers';
import consumerSpec from '../fixtures/consumer-openapi.json';

const SPEC = JSON.stringify({
	openapi: '3.1.0',
	info: { title: 'Demo API', description: 'demo', version: '2.0.0' },
	servers: [{ url: 'https://api.demo.example/v1' }],
	paths: {
		'/pets': { get: { operationId: 'listPets', tags: ['pets'], responses: {} } },
		'/users': { get: { operationId: 'listUsers', tags: ['users'], responses: {} } }
	}
});

const env: Env = {};
const ctx = {
	waitUntil: () => undefined,
	passThroughOnException: () => undefined
} as unknown as ExecutionContext;

function call(url: string, init: RequestInit = {}): Promise<Response> {
	return worker.fetch(new Request(url, init), env, ctx);
}

async function toolsList(url: string): Promise<string[]> {
	const response = await call(url, {
		method: 'POST',
		headers: mcpHeaders('tools/list'),
		body: rpc('tools/list')
	});
	const body = (await response.json()) as { result?: { tools?: { name: string }[] } };
	return (body.result?.tools ?? []).map((t) => t.name);
}

beforeEach(() => clearToolTableCache());
afterEach(() => clearToolTableCache());

describe('splitPath', () => {
	it('keeps the remainder verbatim while decoding the server token once', () => {
		const encoded = encodeURIComponent('https://api.example.com/openapi.json');
		expect(splitPath(`/${encoded}/mcp`)).toEqual({
			token: 'https://api.example.com/openapi.json',
			rest: '/mcp'
		});
	});

	it('handles a plain alias', () => {
		expect(splitPath('/petstore/sse')).toEqual({ token: 'petstore', rest: '/sse' });
	});

	it('defaults the remainder when only a server is given', () => {
		expect(splitPath('/petstore')).toEqual({ token: 'petstore', rest: '/' });
	});

	it('returns undefined for the root path', () => {
		expect(splitPath('/')).toBeUndefined();
	});
});

describe('endpoint matrix', () => {
	const SPEC_ENC = encodeURIComponent('https://api.demo.example/openapi.json');
	const base = `https://mymcp.test/${SPEC_ENC}`;

	beforeEach(() => clearToolTableCache());
	afterEach(() => clearToolTableCache());

	it('answers a preflight with CORS headers', async () => {
		const response = await call(`${base}/mcp`, { method: 'OPTIONS' });

		expect(response.status).toBe(204);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
	});

	it('treats a POST to the SSE path as Streamable HTTP', async () => {
		stubFetch({ 'https://api.demo.example/openapi.json': { body: SPEC } });

		const response = await call(`${base}/sse`, {
			method: 'POST',
			headers: mcpHeaders('tools/list'),
			body: rpc('tools/list')
		});

		expect(response.status).toBe(200);
	});

	it('answers 405 to GET on the SSE path when the Durable Object is not bound', async () => {
		expect((await call(`${base}/sse`)).status).toBe(405);
	});

	it('rejects other methods on the SSE path', async () => {
		expect((await call(`${base}/sse`, { method: 'PUT' })).status).toBe(405);
	});

	it('rejects GET on the message endpoint', async () => {
		expect((await call(`${base}/messages`)).status).toBe(405);
	});

	it('requires a sessionId on the message endpoint once the Durable Object is bound', async () => {
		const bound = { MCP_SSE: {} as unknown as DurableObjectNamespace } as Env;
		const response = await worker.fetch(
			new Request(`${base}/messages`, { method: 'POST', body: '{}' }),
			bound,
			ctx
		);

		expect(response.status).toBe(400);
	});

	it('reports the message endpoint as unavailable without the Durable Object', async () => {
		const response = await call(`${base}/messages?sessionId=abc`, { method: 'POST', body: '{}' });

		expect(response.status).toBe(405);
	});

	it('lists the valid endpoints for an unknown path under a server', async () => {
		const response = await call(`${base}/nope`);
		const body = (await response.json()) as { endpoints: string[] };

		expect(response.status).toBe(404);
		expect(body.endpoints).toHaveLength(3);
	});

	it('serves the landing document at the root', async () => {
		const body = (await (await call('https://mymcp.test/')).json()) as { name: string };

		expect(body.name).toBe('MyMCP');
	});

	it('answers 404 for a favicon when no assets are bound', async () => {
		expect((await call('https://mymcp.test/favicon.ico')).status).toBe(404);
	});

	it('refuses /connect without a signed-in principal', async () => {
		const response = await call('https://mymcp.test/connect?server=petstore&scheme=oauth');

		expect(response.status).toBe(401);
	});
});

describe('environment defaults', () => {
	it('uses a 12 MB spec cap and a 2 MB response cap by default', () => {
		expect(maxSpecBytes({})).toBe(12 * 1024 * 1024);
		expect(maxResponseBytes({})).toBe(2 * 1024 * 1024);
	});

	it('falls back to the default when a cap is not a positive number', () => {
		expect(maxSpecBytes({ MAX_SPEC_BYTES: '-5' })).toBe(12 * 1024 * 1024);
		expect(maxResponseBytes({ MAX_RESPONSE_BYTES: 'many' })).toBe(2 * 1024 * 1024);
	});

	it('treats AUTH_PROVIDER=none as no authorization', () => {
		expect(authEnabled({ AUTH_PROVIDER: 'none' })).toBe(false);
		expect(authEnabled({ AUTH_PROVIDER: 'selfhosted' })).toBe(true);
	});

	it('reads ALLOWLIST_ONLY as a switch', () => {
		expect(allowlistOnly({ ALLOWLIST_ONLY: '1' })).toBe(true);
		expect(allowlistOnly({ ALLOWLIST_ONLY: 'true' })).toBe(true);
		expect(allowlistOnly({ ALLOWLIST_ONLY: '0' })).toBe(false);
	});
});

describe('package entry', () => {
	it('exposes the same handler the worker serves', () => {
		expect(lib.fetch).toBe(worker.fetch);
	});

	it('lists tools from a description through the entry a consumer imports', async () => {
		stubFetch({
			'https://api.consumer.example/openapi.json': { body: JSON.stringify(consumerSpec) }
		});
		const encoded = encodeURIComponent('https://api.consumer.example/openapi.json');
		const response = await lib.fetch(
			new Request(`https://mymcp.test/${encoded}/mcp`, {
				method: 'POST',
				headers: mcpHeaders('tools/list'),
				body: rpc('tools/list')
			}),
			env,
			ctx
		);
		const body = (await response.json()) as { result?: { tools?: { name: string }[] } };

		expect((body.result?.tools ?? []).map((t) => t.name).sort()).toEqual(['getItem', 'listItems']);
	});
});

describe('server resolution', () => {
	it('resolves a percent-encoded description URL, the case that used to 404', async () => {
		stubFetch({ 'https://api.demo.example/openapi.json': { body: SPEC } });
		const encoded = encodeURIComponent('https://api.demo.example/openapi.json');

		expect(await toolsList(`https://mymcp.test/${encoded}/mcp`)).toEqual(['listPets', 'listUsers']);
	});

	it('resolves a bare hostname by assuming https', async () => {
		stubFetch({ 'https://api.demo.example/openapi.json': { body: SPEC } });

		expect(await toolsList('https://mymcp.test/api.demo.example%2Fopenapi.json/mcp')).toEqual([
			'listPets',
			'listUsers'
		]);
	});

	it('rejects a plain http description URL', async () => {
		const encoded = encodeURIComponent('http://api.demo.example/openapi.json');
		const response = await call(`https://mymcp.test/${encoded}/mcp`, {
			method: 'POST',
			headers: mcpHeaders('tools/list'),
			body: rpc('tools/list')
		});

		expect(response.status).toBe(400);
		expect(((await response.json()) as { reason?: string }).reason).toBe('insecure_scheme');
	});

	it('rejects an unknown bare alias', async () => {
		const response = await call('https://mymcp.test/nosuchalias/mcp', {
			method: 'POST',
			headers: mcpHeaders('tools/list'),
			body: rpc('tools/list')
		});

		expect(response.status).toBe(404);
		expect(((await response.json()) as { reason?: string }).reason).toBe('unknown_server');
	});

	it('refuses to reach a private address', async () => {
		const encoded = encodeURIComponent('https://169.254.169.254/openapi.json');
		const response = await call(`https://mymcp.test/${encoded}/mcp`, {
			method: 'POST',
			headers: mcpHeaders('tools/list'),
			body: rpc('tools/list')
		});

		expect(response.status).toBe(500);
		expect(JSON.stringify(await response.json())).toContain('not publicly routable');
	});

	it('serves only preconfigured servers when the allowlist is on', async () => {
		const locked: Env = { ALLOWLIST_ONLY: '1' };
		const encoded = encodeURIComponent('https://api.demo.example/openapi.json');
		const response = await worker.fetch(
			new Request(`https://mymcp.test/${encoded}/mcp`, {
				method: 'POST',
				headers: mcpHeaders('tools/list'),
				body: rpc('tools/list')
			}),
			locked,
			ctx
		);

		expect(response.status).toBe(403);
		expect(((await response.json()) as { reason?: string }).reason).toBe('not_allowlisted');
	});
});

describe('spec discovery', () => {
	it('follows a Scalar documentation page to the real description', async () => {
		stubFetch({
			'https://api.tabroom.example/': {
				body: SCALAR_PAGE,
				headers: { 'Content-Type': 'text/html' }
			},
			'https://api.tabroom.example/v1': { body: SPEC }
		});

		expect(await toolsList('https://mymcp.test/api.tabroom.example/mcp')).toEqual([
			'listPets',
			'listUsers'
		]);
	});

	it('falls back to a well-known path when the page reveals nothing', async () => {
		stubFetch({
			'https://api.plain.example/': {
				body: '<html><body>nothing here</body></html>',
				headers: { 'Content-Type': 'text/html' }
			},
			'https://api.plain.example/openapi.json': { body: SPEC }
		});

		expect(await toolsList('https://mymcp.test/api.plain.example/mcp')).toEqual([
			'listPets',
			'listUsers'
		]);
	});

	it('reports a clear error when nothing resolves', async () => {
		stubFetch({
			'https://api.empty.example/': {
				body: '<html><body>nothing</body></html>',
				headers: { 'Content-Type': 'text/html' }
			}
		});

		const response = await call('https://mymcp.test/api.empty.example/mcp', {
			method: 'POST',
			headers: mcpHeaders('tools/list'),
			body: rpc('tools/list')
		});

		expect(response.status).toBe(422);
		expect(((await response.json()) as { reason?: string }).reason).toBe('not_openapi');
	});
});

describe('filters', () => {
	beforeEach(() => {
		stubFetch({ 'https://api.demo.example/openapi.json': { body: SPEC } });
	});

	const base = `https://mymcp.test/${encodeURIComponent('https://api.demo.example/openapi.json')}/mcp`;

	it('filters by tag', async () => {
		expect(await toolsList(`${base}?tags=users`)).toEqual(['listUsers']);
	});

	it('filters by include glob', async () => {
		expect(await toolsList(`${base}?include=listPets`)).toEqual(['listPets']);
	});

	it('caps the tool count', async () => {
		expect(await toolsList(`${base}?max=1`)).toHaveLength(1);
	});

	it('caches per filter rather than across filters', async () => {
		expect(await toolsList(`${base}?tags=pets`)).toEqual(['listPets']);
		expect(await toolsList(`${base}?tags=users`)).toEqual(['listUsers']);
	});
});

describe('landing page', () => {
	it('describes the endpoints and known servers', async () => {
		const response = await call('https://mymcp.test/');
		const body = (await response.json()) as { servers: string[]; usage: Record<string, string> };

		expect(response.status).toBe(200);
		expect(body.servers).toContain('petstore');
		expect(body.usage.streamableHttp).toContain('/{server}/mcp');
	});

	it('reports an unknown sub-path on a valid server', async () => {
		stubFetch({ 'https://api.demo.example/openapi.json': { body: SPEC } });
		const encoded = encodeURIComponent('https://api.demo.example/openapi.json');
		const response = await call(`https://mymcp.test/${encoded}/nope`);

		expect(response.status).toBe(404);
		expect(((await response.json()) as { error?: string }).error).toBe('Unknown endpoint');
	});
});
