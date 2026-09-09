import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env';
import worker from '../../src/index';
import { clearToolTableCache } from '../../src/resolve';
import { ECHO, SPECS, mcpRequest, requireFixtures, rpcBody, rpcHeaders } from './fixtures';

/**
 * docker/specs/echo.json describes the fixture echo API, which reflects whatever request it
 * receives. That makes the request MyMCP actually puts on the wire directly assertable.
 */
const SPEC_URL = `http://${SPECS}/echo.json`;
const MCP = mcpRequest(SPEC_URL);

const env: Env = { INSECURE_UPSTREAM_HOSTS: `${SPECS},${ECHO}` };
const ctx = {
	waitUntil: () => undefined,
	passThroughOnException: () => undefined
} as unknown as ExecutionContext;

async function call(
	name: string,
	args: Record<string, unknown>,
	extra: Record<string, string> = {}
): Promise<any> {
	const response = await worker.fetch(
		new Request(MCP, {
			method: 'POST',
			headers: rpcHeaders('tools/call', name, extra),
			body: rpcBody('tools/call', { name, arguments: args })
		}),
		env,
		ctx
	);
	return ((await response.json()) as any).result;
}

beforeAll(async () => {
	clearToolTableCache();
	await requireFixtures();
});

describe('the request MyMCP puts on the wire', () => {
	it('substitutes a path parameter', async () => {
		const result = await call('echoGet', { segment: 'hello' });
		expect(result.structuredContent.url).toContain('/anything/hello');
	});

	it('percent-encodes a path value containing a slash', async () => {
		const result = await call('echoGet', { segment: 'a/b' });
		expect(result.structuredContent.url).toContain('/anything/a%2Fb');
	});

	it('merges a path-item parameter into every operation on the path', async () => {
		const result = await call('echoDelete', { segment: 'gone' });
		expect(result.structuredContent.method).toBe('DELETE');
		expect(result.structuredContent.url).toContain('/anything/gone');
	});

	it('repeats an exploded array query parameter', async () => {
		const result = await call('echoGet', { segment: 's', tags: ['x', 'y'] });
		expect(result.structuredContent.args.tags).toEqual(['x', 'y']);
	});

	it('joins a non-exploded array with commas', async () => {
		const result = await call('echoGet', { segment: 's', csv: ['x', 'y'] });
		expect(result.structuredContent.args.csv).toEqual(['x,y']);
	});

	it('sends deepObject query parameters as bracketed keys', async () => {
		const result = await call('echoGet', { segment: 's', filter: { colour: 'red' } });
		expect(result.structuredContent.args['filter[colour]']).toEqual(['red']);
	});

	it('sends a declared header parameter', async () => {
		const result = await call('echoGet', { segment: 's', 'X-Trace': 'trace-1' });
		expect(result.structuredContent.headers['X-Trace']).toEqual(['trace-1']);
	});

	it('sends a JSON body with the right content type', async () => {
		const result = await call('echoPost', { segment: 's', body: { hello: 'world' } });

		expect(result.structuredContent.method).toBe('POST');
		expect(result.structuredContent.headers['Content-Type']).toEqual(['application/json']);
		expect(JSON.parse(result.structuredContent.data)).toEqual({ hello: 'world' });
	});
});

describe('the response MyMCP returns', () => {
	it('decompresses a gzipped response', async () => {
		const result = await call('gzipped', {});
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent.gzipped).toBe(true);
	});

	it('reports a 500 as a tool error rather than a protocol error', async () => {
		const result = await call('serverError', {});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('500');
	});

	it('handles an empty 204 response', async () => {
		const result = await call('noContent', {});
		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain('204');
	});

	it('returns a PNG as an image content block', async () => {
		const result = await call('pngImage', {});
		expect(result.content[0].type).toBe('image');
		expect(result.content[0].mimeType).toBe('image/png');
		expect(result.content[0].data.length).toBeGreaterThan(100);
	});

	it('gives up on a response slower than the timeout', async () => {
		const response = await worker.fetch(
			new Request(MCP, {
				method: 'POST',
				headers: rpcHeaders('tools/call', 'slowResponse'),
				body: rpcBody('tools/call', { name: 'slowResponse', arguments: { seconds: 5 } })
			}),
			{ ...env, FETCH_TIMEOUT_MS: '1000' },
			ctx
		);
		const result = ((await response.json()) as any).result;

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/timeout|did not respond/i);
	});
});

describe('credential forwarding', () => {
	it('applies a bearer credential to the scheme the description declares', async () => {
		const result = await call(
			'needsBearer',
			{},
			{ 'X-Mcp-Upstream-Authorization': 'Bearer real-token' }
		);

		expect(result.structuredContent.authenticated).toBe(true);
		expect(result.structuredContent.token).toBe('real-token');
	});

	it('adds the Bearer prefix when the caller omits it', async () => {
		const result = await call('needsBearer', {}, { 'X-Mcp-Upstream-Authorization': 'raw-token' });
		expect(result.structuredContent.token).toBe('raw-token');
	});

	it('never forwards the MCP Authorization header upstream', async () => {
		const result = await call(
			'echoGet',
			{ segment: 's' },
			{ Authorization: 'Bearer mcp-session-token' }
		);
		expect(JSON.stringify(result.structuredContent.headers)).not.toContain('mcp-session-token');
	});

	it('forwards an undeclared upstream header as an escape hatch', async () => {
		const result = await call('echoGet', { segment: 's' }, { 'X-Mcp-Upstream-X-Tenant': 'acme' });
		expect(result.structuredContent.headers['X-Tenant']).toEqual(['acme']);
	});

	it('drops the credential when a redirect leaves the declared host', async () => {
		const result = await call(
			'followRedirect',
			{ url: `http://${SPECS}/echo.json`, status_code: 302 },
			{ 'X-Mcp-Upstream-Authorization': 'Bearer must-not-leak' }
		);

		// the redirect lands on the specs host, which the description never declares
		expect(JSON.stringify(result)).not.toContain('must-not-leak');
	});

	it('keeps the credential on a redirect that stays on the declared host', async () => {
		const result = await call(
			'followRedirect',
			{ url: `http://${ECHO}/bearer`, status_code: 302 },
			{ 'X-Mcp-Upstream-Authorization': 'Bearer stays-put' }
		);

		expect(result.structuredContent.token).toBe('stays-put');
	});
});

describe('the network policy against real hosts', () => {
	it('refuses a description on a private address that is not opted in', async () => {
		const response = await worker.fetch(
			new Request(mcpRequest(`http://${SPECS}/echo.json`), {
				method: 'POST',
				headers: rpcHeaders('tools/list'),
				body: rpcBody('tools/list')
			}),
			{},
			ctx
		);

		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(JSON.stringify(await response.json())).toMatch(/https|not publicly routable/i);
	});
});
