import { env as testEnv } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadUpstreamCredentials } from '../../src/auth/resource';
import { clearJwksCache } from '../../src/auth/jwt';
import type { Env } from '../../src/env';
import worker from '../../src/index';
import { clearToolTableCache } from '../../src/resolve';
import { toBase64Url } from '../../src/state';
import { stubFetch } from '../helpers';

const ISSUER = 'https://auth.example.com';
const JWKS_URL = `${ISSUER}/jwks`;

const SPEC = JSON.stringify({
	openapi: '3.1.0',
	info: { title: 'Connected API', description: 'c', version: '1.0.0' },
	servers: [{ url: 'https://api.connected.example' }],
	security: [{ oauth: ['read'] }],
	components: {
		securitySchemes: {
			oauth: {
				type: 'oauth2',
				flows: {
					authorizationCode: {
						authorizationUrl: 'https://auth.connected.example/authorize',
						tokenUrl: 'https://auth.connected.example/token',
						scopes: { read: 'Read' }
					}
				}
			},
			plainKey: { type: 'apiKey', name: 'X-Api-Key', in: 'header' }
		}
	},
	paths: { '/things': { get: { operationId: 'listThings', responses: {} } } }
});

const SPEC_URL = 'https://api.connected.example/openapi.json';
const TOKEN_SERVER = encodeURIComponent(SPEC_URL);

const ctx = {
	waitUntil: () => undefined,
	passThroughOnException: () => undefined
} as unknown as ExecutionContext;

let signingKey: CryptoKey;
let jwks: string;

async function makeKey() {
	const pair = (await crypto.subtle.generateKey(
		{
			name: 'RSASSA-PKCS1-v1_5',
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: 'SHA-256'
		},
		true,
		['sign', 'verify']
	)) as CryptoKeyPair;

	const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as unknown as Record<
		string,
		unknown
	>;
	signingKey = pair.privateKey;
	jwks = JSON.stringify({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256' }] });
}

async function token(resource: string): Promise<string> {
	const header = toBase64Url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', kid: 'k1' })));
	const payload = toBase64Url(
		new TextEncoder().encode(
			JSON.stringify({
				iss: ISSUER,
				sub: 'user-1',
				aud: resource,
				exp: Math.floor(Date.now() / 1000) + 600,
				scope: 'mcp:tools'
			})
		)
	);
	const signature = await crypto.subtle.sign(
		'RSASSA-PKCS1-v1_5',
		signingKey,
		new TextEncoder().encode(`${header}.${payload}`) as unknown as BufferSource
	);
	return `${header}.${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

const authEnv = (): Env => ({
	...(testEnv as unknown as Env),
	AUTH_PROVIDER: 'oidc',
	AUTH_ISSUER: ISSUER,
	AUTH_JWKS_URL: JWKS_URL,
	STATE_SECRET: 'connect-test-secret'
});

beforeEach(async () => {
	clearToolTableCache();
	clearJwksCache();
	if (!signingKey) await makeKey();
	stubFetch({ [SPEC_URL]: { body: SPEC }, [JWKS_URL]: { body: jwks } });
});
afterEach(() => {
	vi.unstubAllGlobals();
	clearToolTableCache();
	clearJwksCache();
});

describe('/connect', () => {
	it('requires authentication', async () => {
		const response = await worker.fetch(
			new Request(`https://mymcp.test/connect?server=${TOKEN_SERVER}&scheme=oauth`),
			authEnv(),
			ctx
		);
		expect(response.status).toBe(401);
	});

	it('redirects to the upstream authorization endpoint', async () => {
		const bearer = await token('https://mymcp.test/connect');
		const response = await worker.fetch(
			new Request(`https://mymcp.test/connect?server=${TOKEN_SERVER}&scheme=oauth`, {
				headers: { Authorization: `Bearer ${bearer}` }
			}),
			authEnv(),
			ctx
		);

		expect(response.status).toBe(302);
		const location = new URL(response.headers.get('Location')!);
		expect(location.origin + location.pathname).toBe('https://auth.connected.example/authorize');
		expect(location.searchParams.get('response_type')).toBe('code');
		expect(location.searchParams.get('redirect_uri')).toBe('https://mymcp.test/connect/callback');
		expect(location.searchParams.get('state')).toBeTruthy();
	});

	it('explains when the API describes no OAuth flow', async () => {
		const bearer = await token('https://mymcp.test/connect');
		const response = await worker.fetch(
			new Request(`https://mymcp.test/connect?server=${TOKEN_SERVER}&scheme=plainKey`, {
				headers: { Authorization: `Bearer ${bearer}` }
			}),
			authEnv(),
			ctx
		);

		expect(response.status).toBe(400);
		expect(await response.text()).toContain('X-Mcp-Upstream-Authorization');
	});

	it('requires a server', async () => {
		const bearer = await token('https://mymcp.test/connect');
		const response = await worker.fetch(
			new Request('https://mymcp.test/connect', { headers: { Authorization: `Bearer ${bearer}` } }),
			authEnv(),
			ctx
		);

		expect(response.status).toBe(400);
	});
});

describe('/connect/callback', () => {
	async function startConnect(): Promise<string> {
		const bearer = await token('https://mymcp.test/connect');
		const response = await worker.fetch(
			new Request(`https://mymcp.test/connect?server=${TOKEN_SERVER}&scheme=oauth`, {
				headers: { Authorization: `Bearer ${bearer}` }
			}),
			authEnv(),
			ctx
		);
		return new URL(response.headers.get('Location')!).searchParams.get('state')!;
	}

	it('requires authentication', async () => {
		const response = await worker.fetch(
			new Request('https://mymcp.test/connect/callback?code=abc&state=x'),
			authEnv(),
			ctx
		);
		expect(response.status).toBe(401);
	});

	it('stores the credential against the verified principal', async () => {
		const state = await startConnect();
		const bearer = await token('https://mymcp.test/connect/callback');

		const response = await worker.fetch(
			new Request(
				`https://mymcp.test/connect/callback?code=upstream-code&state=${encodeURIComponent(state)}`,
				{
					headers: { Authorization: `Bearer ${bearer}` }
				}
			),
			authEnv(),
			ctx
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toContain('api.connected.example');

		const stored = await loadUpstreamCredentials(
			authEnv(),
			{ sub: 'user-1', scopes: [] },
			'api.connected.example',
			['oauth']
		);
		expect(stored.get('oauth')).toBe('upstream-code');
	});

	it('rejects a forged state', async () => {
		const bearer = await token('https://mymcp.test/connect/callback');
		const response = await worker.fetch(
			new Request('https://mymcp.test/connect/callback?code=abc&state=forged', {
				headers: { Authorization: `Bearer ${bearer}` }
			}),
			authEnv(),
			ctx
		);

		expect(response.status).toBe(400);
		expect(JSON.stringify(await response.json())).toContain('invalid or has expired');
	});

	it('reports an upstream authorization error', async () => {
		const state = await startConnect();
		const bearer = await token('https://mymcp.test/connect/callback');

		const response = await worker.fetch(
			new Request(
				`https://mymcp.test/connect/callback?error=access_denied&state=${encodeURIComponent(state)}`,
				{ headers: { Authorization: `Bearer ${bearer}` } }
			),
			authEnv(),
			ctx
		);

		expect(response.status).toBe(400);
		expect(JSON.stringify(await response.json())).toContain('access_denied');
	});
});

describe('stored credentials in a tool call', () => {
	it('uses a stored upstream token when the caller supplies none', async () => {
		const state = await startConnectFlow();
		const callbackBearer = await token('https://mymcp.test/connect/callback');

		await worker.fetch(
			new Request(
				`https://mymcp.test/connect/callback?code=stored-token&state=${encodeURIComponent(state)}`,
				{
					headers: { Authorization: `Bearer ${callbackBearer}` }
				}
			),
			authEnv(),
			ctx
		);

		const stub = stubFetch({
			[SPEC_URL]: { body: SPEC },
			[JWKS_URL]: { body: jwks },
			'https://api.connected.example/things': { body: '[]' }
		});

		const mcpUrl = `https://mymcp.test/${TOKEN_SERVER}/mcp`;
		const bearer = await token(mcpUrl);

		await worker.fetch(
			new Request(mcpUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${bearer}`,
					'MCP-Protocol-Version': '2026-07-28',
					'Mcp-Method': 'tools/call',
					'Mcp-Name': 'listThings'
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/call',
					params: {
						name: 'listThings',
						arguments: {},
						_meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' }
					}
				})
			}),
			authEnv(),
			ctx
		);

		const upstream = stub.requests.find((r) => r.url.includes('/things'));
		expect(upstream?.headers.authorization).toBe('Bearer stored-token');
	});

	async function startConnectFlow(): Promise<string> {
		const bearer = await token('https://mymcp.test/connect');
		const response = await worker.fetch(
			new Request(`https://mymcp.test/connect?server=${TOKEN_SERVER}&scheme=oauth`, {
				headers: { Authorization: `Bearer ${bearer}` }
			}),
			authEnv(),
			ctx
		);
		return new URL(response.headers.get('Location')!).searchParams.get('state')!;
	}
});
