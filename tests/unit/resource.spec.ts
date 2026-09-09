import { env as testEnv } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getIdentityProvider } from '../../src/auth/identity';
import { clearJwksCache, scopesOf, verifyJwt } from '../../src/auth/jwt';
import {
	PROTECTED_RESOURCE_PATH,
	bearerToken,
	canonicalResource,
	insufficientScope,
	loadUpstreamCredentials,
	protectedResourceMetadata,
	schemeAuthorizationUrl,
	storeUpstreamCredential,
	unauthorized
} from '../../src/auth/resource';
import type { Env } from '../../src/env';
import worker from '../../src/index';
import { toBase64Url } from '../../src/state';
import { clearToolTableCache } from '../../src/resolve';
import { stubFetch } from '../helpers';

const kvEnv = testEnv as unknown as Env;
const ctx = {
	waitUntil: () => undefined,
	passThroughOnException: () => undefined
} as unknown as ExecutionContext;

const ISSUER = 'https://auth.example.com';
const JWKS_URL = `${ISSUER}/jwks`;
const AUDIENCE = 'https://mymcp.test/petstore/mcp';

async function makeSigningKey() {
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
	return {
		pair,
		jwks: JSON.stringify({ keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] })
	};
}

async function signJwt(key: CryptoKey, claims: Record<string, unknown>): Promise<string> {
	const header = toBase64Url(
		new TextEncoder().encode(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' }))
	);
	const payload = toBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
	const data = new TextEncoder().encode(`${header}.${payload}`);

	const signature = await crypto.subtle.sign(
		'RSASSA-PKCS1-v1_5',
		key,
		data as unknown as BufferSource
	);
	return `${header}.${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

beforeEach(() => {
	clearJwksCache();
	clearToolTableCache();
});
afterEach(() => {
	vi.unstubAllGlobals();
	clearJwksCache();
});

describe('verifyJwt', () => {
	it('verifies a correctly signed token', async () => {
		const { pair, jwks } = await makeSigningKey();
		stubFetch({ [JWKS_URL]: { body: jwks } });

		const token = await signJwt(pair.privateKey, {
			iss: ISSUER,
			sub: 'user-1',
			aud: AUDIENCE,
			exp: Math.floor(Date.now() / 1000) + 600,
			scope: 'mcp:tools mcp:read'
		});

		const claims = await verifyJwt(token, {
			jwksUrl: JWKS_URL,
			issuer: ISSUER,
			audience: AUDIENCE
		});
		expect(claims?.sub).toBe('user-1');
		expect(scopesOf(claims!)).toEqual(['mcp:tools', 'mcp:read']);
	});

	it('rejects a token signed by a different key', async () => {
		const signer = await makeSigningKey();
		const other = await makeSigningKey();
		stubFetch({ [JWKS_URL]: { body: other.jwks } });

		const token = await signJwt(signer.pair.privateKey, {
			iss: ISSUER,
			sub: 'user-1',
			aud: AUDIENCE,
			exp: Math.floor(Date.now() / 1000) + 600
		});

		expect(
			await verifyJwt(token, { jwksUrl: JWKS_URL, issuer: ISSUER, audience: AUDIENCE })
		).toBeNull();
	});

	it('rejects an expired token', async () => {
		const { pair, jwks } = await makeSigningKey();
		stubFetch({ [JWKS_URL]: { body: jwks } });

		const token = await signJwt(pair.privateKey, {
			iss: ISSUER,
			sub: 'user-1',
			aud: AUDIENCE,
			exp: Math.floor(Date.now() / 1000) - 3600
		});

		expect(
			await verifyJwt(token, { jwksUrl: JWKS_URL, issuer: ISSUER, audience: AUDIENCE })
		).toBeNull();
	});

	it('rejects a token for a different audience', async () => {
		const { pair, jwks } = await makeSigningKey();
		stubFetch({ [JWKS_URL]: { body: jwks } });

		const token = await signJwt(pair.privateKey, {
			iss: ISSUER,
			sub: 'user-1',
			aud: 'https://someone.else/mcp',
			exp: Math.floor(Date.now() / 1000) + 600
		});

		expect(
			await verifyJwt(token, { jwksUrl: JWKS_URL, issuer: ISSUER, audience: AUDIENCE })
		).toBeNull();
	});

	it('rejects a token from a different issuer', async () => {
		const { pair, jwks } = await makeSigningKey();
		stubFetch({ [JWKS_URL]: { body: jwks } });

		const token = await signJwt(pair.privateKey, {
			iss: 'https://evil.example',
			sub: 'user-1',
			aud: AUDIENCE,
			exp: Math.floor(Date.now() / 1000) + 600
		});

		expect(
			await verifyJwt(token, { jwksUrl: JWKS_URL, issuer: ISSUER, audience: AUDIENCE })
		).toBeNull();
	});

	it('rejects a malformed token without throwing', async () => {
		stubFetch({ [JWKS_URL]: { body: '{"keys":[]}' } });

		expect(await verifyJwt('not.a.jwt', { jwksUrl: JWKS_URL })).toBeNull();
		expect(await verifyJwt('onlyonepart', { jwksUrl: JWKS_URL })).toBeNull();
	});

	it('rejects an unsupported algorithm, including none', async () => {
		stubFetch({ [JWKS_URL]: { body: '{"keys":[]}' } });

		const header = toBase64Url(new TextEncoder().encode(JSON.stringify({ alg: 'none' })));
		const payload = toBase64Url(new TextEncoder().encode(JSON.stringify({ sub: 'x' })));

		expect(await verifyJwt(`${header}.${payload}.`, { jwksUrl: JWKS_URL })).toBeNull();
	});
});

describe('scopesOf', () => {
	it('reads scope, scp string and scp array forms', () => {
		expect(scopesOf({ scope: 'a b' })).toEqual(['a', 'b']);
		expect(scopesOf({ scp: 'a b' })).toEqual(['a', 'b']);
		expect(scopesOf({ scp: ['a', 'b'] })).toEqual(['a', 'b']);
		expect(scopesOf({})).toEqual([]);
	});
});

describe('protected resource metadata', () => {
	const provider = {
		name: 'test',
		authorizationServers: () => [ISSUER],
		scopesSupported: () => ['mcp:tools'],
		verify: async () => null
	};

	it('serves an RFC 9728 document', async () => {
		const url = new URL('https://mymcp.test/.well-known/oauth-protected-resource');
		const body = (await protectedResourceMetadata(url, provider, AUDIENCE).json()) as any;

		expect(body.resource).toBe(AUDIENCE);
		expect(body.authorization_servers).toEqual([ISSUER]);
		expect(body.scopes_supported).toEqual(['mcp:tools']);
		expect(body.bearer_methods_supported).toEqual(['header']);
	});

	it('builds a canonical resource URI without a trailing slash', () => {
		expect(canonicalResource(new URL('https://mymcp.test/petstore/mcp/'))).toBe(
			'https://mymcp.test/petstore/mcp'
		);
	});
});

describe('authorization challenges', () => {
	const url = new URL('https://mymcp.test/petstore/mcp');

	it('returns 401 with resource metadata and scope', () => {
		const response = unauthorized(url, ['mcp:tools']);
		const challenge = response.headers.get('WWW-Authenticate') ?? '';

		expect(response.status).toBe(401);
		expect(challenge).toContain('Bearer resource_metadata=');
		expect(challenge).toContain(PROTECTED_RESOURCE_PATH);
		expect(challenge).toContain('scope="mcp:tools"');
	});

	it('returns 403 with every required scope in one challenge', () => {
		const response = insufficientScope(url, ['files:read', 'files:write']);
		const challenge = response.headers.get('WWW-Authenticate') ?? '';

		expect(response.status).toBe(403);
		expect(challenge).toContain('error="insufficient_scope"');
		expect(challenge).toContain('scope="files:read files:write"');
	});
});

describe('bearerToken', () => {
	it('reads a bearer token case-insensitively', () => {
		expect(
			bearerToken(new Request('https://x.test', { headers: { Authorization: 'Bearer abc' } }))
		).toBe('abc');
		expect(
			bearerToken(new Request('https://x.test', { headers: { Authorization: 'bearer abc' } }))
		).toBe('abc');
	});

	it('returns undefined for other schemes or no header', () => {
		expect(
			bearerToken(new Request('https://x.test', { headers: { Authorization: 'Basic abc' } }))
		).toBeUndefined();
		expect(bearerToken(new Request('https://x.test'))).toBeUndefined();
	});
});

describe('upstream credential storage', () => {
	it('stores and reloads a credential bound to a principal', async () => {
		await storeUpstreamCredential(kvEnv, 'user-1', 'api.example.com', 'oauth', 'token-1');

		const loaded = await loadUpstreamCredentials(
			kvEnv,
			{ sub: 'user-1', scopes: [] },
			'api.example.com',
			['oauth']
		);
		expect(loaded.get('oauth')).toBe('token-1');
	});

	it('never hands one principal the credential of another', async () => {
		await storeUpstreamCredential(kvEnv, 'user-1', 'api.example.com', 'oauth', 'token-1');

		const loaded = await loadUpstreamCredentials(
			kvEnv,
			{ sub: 'user-2', scopes: [] },
			'api.example.com',
			['oauth']
		);
		expect(loaded.size).toBe(0);
	});

	it('returns nothing without KV or without a principal', async () => {
		expect((await loadUpstreamCredentials({}, { sub: 'u', scopes: [] }, 'h', ['s'])).size).toBe(0);
		expect((await loadUpstreamCredentials(kvEnv, undefined, 'h', ['s'])).size).toBe(0);
	});
});

describe('schemeAuthorizationUrl', () => {
	it('finds the authorization endpoint of an oauth2 scheme', () => {
		expect(
			schemeAuthorizationUrl({
				type: 'oauth2',
				flows: { authorizationCode: { authorizationUrl: 'https://a.example/authorize' } }
			})
		).toBe('https://a.example/authorize');
	});

	it('returns undefined when there is no flow', () => {
		expect(schemeAuthorizationUrl({ type: 'apiKey', name: 'k', in: 'header' })).toBeUndefined();
		expect(schemeAuthorizationUrl(undefined)).toBeUndefined();
	});
});

describe('identity provider selection', () => {
	it('returns undefined when unconfigured', () => {
		expect(getIdentityProvider({})).toBeUndefined();
		expect(getIdentityProvider({ AUTH_PROVIDER: 'none' })).toBeUndefined();
	});

	it('builds the Cloudflare Access provider', () => {
		const provider = getIdentityProvider({
			AUTH_PROVIDER: 'access',
			ACCESS_TEAM_DOMAIN: 'acme.cloudflareaccess.com'
		});
		expect(provider?.name).toBe('access');
		expect(provider?.authorizationServers()).toEqual(['https://acme.cloudflareaccess.com']);
	});

	it('builds the generic OIDC provider', () => {
		const provider = getIdentityProvider({ AUTH_PROVIDER: 'oidc', AUTH_ISSUER: ISSUER });
		expect(provider?.name).toBe('oidc');
		expect(provider?.authorizationServers()).toEqual([ISSUER]);
	});

	it('builds the self-hosted provider only when KV is bound', () => {
		expect(getIdentityProvider({ AUTH_PROVIDER: 'selfhosted' })).toBeUndefined();
		expect(getIdentityProvider({ ...kvEnv, AUTH_PROVIDER: 'selfhosted' })?.name).toBe('selfhosted');
	});

	it('needs a team domain for Cloudflare Access', () => {
		expect(getIdentityProvider({ AUTH_PROVIDER: 'access' })).toBeUndefined();
	});
});

describe('authorization enforcement on MCP endpoints', () => {
	const authEnv: Env = {
		...kvEnv,
		AUTH_PROVIDER: 'oidc',
		AUTH_ISSUER: ISSUER,
		AUTH_JWKS_URL: JWKS_URL
	};

	it('challenges an unauthenticated MCP request', async () => {
		stubFetch({ [JWKS_URL]: { body: '{"keys":[]}' } });

		const response = await worker.fetch(
			new Request('https://mymcp.test/petstore/mcp', { method: 'POST', body: '{}' }),
			authEnv,
			ctx
		);

		expect(response.status).toBe(401);
		expect(response.headers.get('WWW-Authenticate')).toContain('resource_metadata=');
	});

	it('serves protected resource metadata', async () => {
		const response = await worker.fetch(
			new Request(`https://mymcp.test${PROTECTED_RESOURCE_PATH}`),
			authEnv,
			ctx
		);
		const body = (await response.json()) as any;

		expect(response.status).toBe(200);
		expect(body.authorization_servers).toEqual([ISSUER]);
	});

	it('reports metadata as absent when authorization is off', async () => {
		const response = await worker.fetch(
			new Request(`https://mymcp.test${PROTECTED_RESOURCE_PATH}`),
			{},
			ctx
		);
		expect(response.status).toBe(404);
	});

	it('lets an unauthenticated request through when no provider is configured', async () => {
		stubFetch({
			'https://api.open.example/spec': {
				body: JSON.stringify({
					openapi: '3.1.0',
					info: { title: 'Open', description: 'o', version: '1' },
					servers: [{ url: 'https://api.open.example' }],
					paths: {}
				})
			}
		});

		const response = await worker.fetch(
			new Request(`https://mymcp.test/${encodeURIComponent('https://api.open.example/spec')}/mcp`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'MCP-Protocol-Version': '2026-07-28',
					'Mcp-Method': 'tools/list'
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/list',
					params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } }
				})
			}),
			{},
			ctx
		);

		expect(response.status).toBe(200);
	});
});
