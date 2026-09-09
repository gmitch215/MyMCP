import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker, { splitPath } from '../../src/index';
import type { Env } from '../../src/env';
import { clearToolTableCache } from '../../src/resolve';
import { SCALAR_PAGE, mcpHeaders, rpc, stubFetch } from '../helpers';

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
