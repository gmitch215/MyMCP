import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearLoginTokens, readLoginRecipe } from '../../src/auth/login';
import { readSuppliedCredentials } from '../../src/auth/upstream';
import type { Env } from '../../src/env';
import worker from '../../src/index';
import { clearToolTableCache } from '../../src/resolve';

// the shape of the real Tabroom description: a relative server, a cookie scheme, and account
// operations that declare no security of their own
const TABROOM_SPEC = JSON.stringify({
	openapi: '3.1.0',
	info: { title: 'IndexCards API', version: '1.0.0' },
	servers: [{ url: '/v1' }],
	components: {
		securitySchemes: {
			cookieAuth: { type: 'apiKey', in: 'cookie', name: 'TabroomToken' }
		}
	},
	paths: {
		'/auth/login': {
			post: {
				operationId: 'authLogin',
				tags: ['Auth'],
				security: [],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: { username: { type: 'string' }, password: { type: 'string' } }
							}
						}
					}
				},
				responses: {}
			}
		},
		'/user/session': { get: { operationId: 'UserSession', tags: ['User'], responses: {} } }
	}
});

const BEARER_SPEC = JSON.stringify({
	openapi: '3.1.0',
	info: { title: 'Bearer API', version: '1.0.0' },
	servers: [{ url: 'https://api.bearer.example' }],
	components: { securitySchemes: { jwt: { type: 'http', scheme: 'bearer' } } },
	security: [{ jwt: [] }],
	paths: {
		'/signin': {
			post: {
				operationId: 'signIn',
				security: [],
				requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
				responses: {}
			}
		},
		'/me': { get: { operationId: 'me', responses: {} } }
	}
});

const BEARER_SPEC_URL = 'https://api.bearer.example/openapi.json';

const env: Env = {};
const ctx = {
	waitUntil: () => undefined,
	passThroughOnException: () => undefined
} as unknown as ExecutionContext;

interface Seen {
	url: string;
	headers: Record<string, string>;
	body?: string;
}

/** a fake upstream whose sessions can be expired, so the retry path is reachable */
function upstream() {
	const seen: Seen[] = [];
	const state = { logins: 0, valid: '', password: 'hunter2' };

	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input instanceof Request ? input.url : input);
			const headers: Record<string, string> = {};
			new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
			const body = typeof init?.body === 'string' ? init.body : undefined;
			seen.push({ url, headers, body });

			const reply = (status: number, value: unknown) =>
				new Response(JSON.stringify(value), {
					status,
					headers: { 'Content-Type': 'application/json' }
				});

			if (url === 'https://api.tabroom.com/v1') return reply(200, JSON.parse(TABROOM_SPEC));
			if (url === BEARER_SPEC_URL) return reply(200, JSON.parse(BEARER_SPEC));

			if (url.endsWith('/auth/login') || url.endsWith('/signin')) {
				const sent = JSON.parse(body ?? '{}') as { password?: string };
				if (sent.password !== state.password) return reply(401, { detail: 'Bad password' });
				state.logins++;
				state.valid = `tok${state.logins}`;
				return url.endsWith('/signin')
					? reply(200, { data: { jwt: state.valid } })
					: reply(200, { token: state.valid, Person: { id: 1 } });
			}

			const authed =
				headers['cookie'] === `TabroomToken=${state.valid}` ||
				headers['authorization'] === `Bearer ${state.valid}`;
			return authed ? reply(200, { id: 1 }) : reply(401, { detail: 'User not Authenticated' });
		})
	);

	return { seen, state };
}

async function callTool(
	url: string,
	name: string,
	headers: Record<string, string>
): Promise<{ text: string; isError: boolean }> {
	const response = await worker.fetch(
		new Request(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'MCP-Protocol-Version': '2026-07-28',
				'Mcp-Method': 'tools/call',
				'Mcp-Name': name,
				...headers
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: {
					name,
					arguments: {},
					_meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' }
				}
			})
		}),
		env,
		ctx
	);
	const body = (await response.json()) as {
		result: { content: { text: string }[]; isError?: boolean };
	};
	return {
		text: body.result.content.map((c) => c.text).join('\n'),
		isError: body.result.isError === true
	};
}

const LOGIN = {
	'X-Mcp-Upstream-Login-Username': 'judge@example.com',
	'X-Mcp-Upstream-Login-Password': 'hunter2'
};

beforeEach(() => {
	clearToolTableCache();
	clearLoginTokens();
});
afterEach(() => {
	vi.unstubAllGlobals();
	clearToolTableCache();
});

describe('login proxy', () => {
	it('logs in through the alias recipe and sends the token under the declared cookie name', async () => {
		const { seen } = upstream();

		const result = await callTool('https://mymcp.test/tabroom/mcp', 'UserSession', LOGIN);

		expect(result).toEqual({ text: '{"id":1}', isError: false });
		const login = seen.find((r) => r.url.endsWith('/auth/login'))!;
		expect(JSON.parse(login.body!)).toEqual({ username: 'judge@example.com', password: 'hunter2' });
		const call = seen.find((r) => r.url.endsWith('/user/session'))!;
		expect(call.headers['cookie']).toBe('TabroomToken=tok1');
		for (const request of seen) {
			expect(Object.keys(request.headers).join()).not.toContain('login');
		}
	});

	it('reuses the token across calls', async () => {
		const { state } = upstream();

		await callTool('https://mymcp.test/tabroom/mcp', 'UserSession', LOGIN);
		const second = await callTool('https://mymcp.test/tabroom/mcp', 'UserSession', LOGIN);

		expect(second.isError).toBe(false);
		expect(state.logins).toBe(1);
	});

	it('logs in again once when a cached token is rejected', async () => {
		const { state } = upstream();

		await callTool('https://mymcp.test/tabroom/mcp', 'UserSession', LOGIN);
		state.valid = 'expired';
		const result = await callTool('https://mymcp.test/tabroom/mcp', 'UserSession', LOGIN);

		expect(result.isError).toBe(false);
		expect(state.logins).toBe(2);
	});

	it('finds the login operation even when a filter hides it', async () => {
		const { state } = upstream();

		const result = await callTool('https://mymcp.test/tabroom/mcp?tags=User', 'UserSession', LOGIN);

		expect(result.isError).toBe(false);
		expect(state.logins).toBe(1);
	});

	it('takes the recipe from query parameters on any description', async () => {
		const { seen } = upstream();
		const url = `https://mymcp.test/${encodeURIComponent(BEARER_SPEC_URL)}/mcp?login=signIn&loginToken=data.jwt`;

		const result = await callTool(url, 'me', LOGIN);

		expect(result.isError).toBe(false);
		expect(seen.find((r) => r.url.endsWith('/me'))!.headers['authorization']).toBe('Bearer tok1');
	});

	it('reports a failed login without echoing the password', async () => {
		const { state } = upstream();
		state.password = 'something-else';

		const result = await callTool('https://mymcp.test/tabroom/mcp', 'UserSession', LOGIN);

		expect(result.isError).toBe(true);
		expect(result.text).toContain('Login through authLogin failed');
		expect(result.text).toContain('Bad password');
		expect(result.text).not.toContain('hunter2');
	});

	it('reports a login response with no token at the configured path', async () => {
		upstream();
		const url = `https://mymcp.test/${encodeURIComponent(BEARER_SPEC_URL)}/mcp?login=signIn&loginToken=nope`;

		const result = await callTool(url, 'me', LOGIN);

		expect(result).toMatchObject({ isError: true });
		expect(result.text).toContain('returned no token at "nope"');
	});

	it('rejects login headers on a server with no recipe', async () => {
		upstream();

		const result = await callTool(
			`https://mymcp.test/${encodeURIComponent(BEARER_SPEC_URL)}/mcp`,
			'me',
			LOGIN
		);

		expect(result.isError).toBe(true);
		expect(result.text).toContain('no login recipe');
	});

	it('rejects a recipe naming an operation the description lacks', async () => {
		upstream();
		const url = `https://mymcp.test/${encodeURIComponent(BEARER_SPEC_URL)}/mcp?login=nosuch`;

		const result = await callTool(url, 'me', LOGIN);

		expect(result.text).toContain('nosuch is not in this description');
	});

	it('rejects a scheme the description does not declare', async () => {
		upstream();
		const url = `https://mymcp.test/${encodeURIComponent(BEARER_SPEC_URL)}/mcp?login=signIn&loginScheme=other`;

		const result = await callTool(url, 'me', LOGIN);

		expect(result.text).toContain('declared: jwt');
	});

	it('leaves calls alone when no login headers are sent', async () => {
		const { state } = upstream();

		const result = await callTool('https://mymcp.test/tabroom/mcp', 'UserSession', {});

		expect(result.isError).toBe(true);
		expect(state.logins).toBe(0);
	});
});

describe('readLoginRecipe', () => {
	it('lets query parameters override the alias recipe', () => {
		const recipe = readLoginRecipe(
			new URL('https://x.test/mcp?loginToken=data.token'),
			{ operationId: 'authLogin', token: 'token', scheme: 'cookieAuth' },
			['cookieAuth']
		);
		expect(recipe).toEqual({ operationId: 'authLogin', token: 'data.token', scheme: 'cookieAuth' });
	});

	it('leaves the scheme empty when several are declared and none is named', () => {
		const recipe = readLoginRecipe(new URL('https://x.test/mcp?login=signIn'), undefined, [
			'a',
			'b'
		]);
		expect(recipe).toEqual({ operationId: 'signIn', token: 'token', scheme: '' });
	});

	it('returns nothing without an operation', () => {
		expect(readLoginRecipe(new URL('https://x.test/mcp'), undefined, ['a'])).toBeUndefined();
	});
});

describe('login headers', () => {
	it('needs both a username and a password', () => {
		const half = readSuppliedCredentials(
			new Headers({ 'X-Mcp-Upstream-Login-Username': 'judge@example.com' })
		);
		expect(half.login).toBeUndefined();
		expect(half.headers.size).toBe(0);
	});
});
