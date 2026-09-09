import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccessProvider } from '../../src/auth/identity/access';
import { clearMetadataCache, createOidcProvider } from '../../src/auth/identity/oidc';
import { clearJwksCache } from '../../src/auth/jwt';
import { toBase64Url } from '../../src/state';
import { stubFetch } from '../helpers';

const ISSUER = 'https://auth.example.com';
const JWKS_URL = `${ISSUER}/jwks`;
const RESOURCE = 'https://mymcp.test/petstore/mcp';

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
	return { pair, jwks: JSON.stringify({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256' }] }) };
}

async function sign(key: CryptoKey, claims: Record<string, unknown>): Promise<string> {
	const header = toBase64Url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', kid: 'k1' })));
	const payload = toBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
	const signature = await crypto.subtle.sign(
		'RSASSA-PKCS1-v1_5',
		key,
		new TextEncoder().encode(`${header}.${payload}`) as unknown as BufferSource
	);
	return `${header}.${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

function claims(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		iss: ISSUER,
		sub: 'user-9',
		aud: RESOURCE,
		exp: Math.floor(Date.now() / 1000) + 600,
		...extra
	};
}

beforeEach(() => {
	clearJwksCache();
	clearMetadataCache();
});
afterEach(() => {
	vi.unstubAllGlobals();
	clearJwksCache();
	clearMetadataCache();
});

describe('OIDC provider', () => {
	it('requires an issuer', () => {
		expect(createOidcProvider({ AUTH_PROVIDER: 'oidc' })).toBeUndefined();
	});

	it('reports its issuer and scopes', () => {
		const provider = createOidcProvider({ AUTH_ISSUER: ISSUER, AUTH_SCOPES: 'a b' })!;
		expect(provider.authorizationServers()).toEqual([ISSUER]);
		expect(provider.scopesSupported()).toEqual(['a', 'b']);
	});

	it('falls back to the default scopes', () => {
		expect(createOidcProvider({ AUTH_ISSUER: ISSUER })!.scopesSupported()).toEqual([
			'mcp:tools',
			'mcp:read'
		]);
	});

	it('discovers the JWKS through OpenID Connect discovery', async () => {
		const { pair, jwks } = await makeKey();
		stubFetch({
			[`${ISSUER}/.well-known/openid-configuration`]: {
				body: JSON.stringify({ issuer: ISSUER, jwks_uri: JWKS_URL })
			},
			[JWKS_URL]: { body: jwks }
		});

		const provider = createOidcProvider({ AUTH_ISSUER: ISSUER })!;
		const principal = await provider.verify(await sign(pair.privateKey, claims()), RESOURCE);

		expect(principal?.sub).toBe('user-9');
	});

	it('falls back to RFC 8414 authorization server metadata', async () => {
		const { pair, jwks } = await makeKey();
		stubFetch({
			[`${ISSUER}/.well-known/openid-configuration`]: { status: 404, body: 'no' },
			[`${ISSUER}/.well-known/oauth-authorization-server`]: {
				body: JSON.stringify({ issuer: ISSUER, jwks_uri: JWKS_URL })
			},
			[JWKS_URL]: { body: jwks }
		});

		const provider = createOidcProvider({ AUTH_ISSUER: ISSUER })!;
		expect((await provider.verify(await sign(pair.privateKey, claims()), RESOURCE))?.sub).toBe(
			'user-9'
		);
	});

	it('uses a configured JWKS URL without discovering', async () => {
		const { pair, jwks } = await makeKey();
		const stub = stubFetch({ [JWKS_URL]: { body: jwks } });

		const provider = createOidcProvider({ AUTH_ISSUER: ISSUER, AUTH_JWKS_URL: JWKS_URL })!;
		await provider.verify(await sign(pair.privateKey, claims()), RESOURCE);

		expect(stub.requests.every((r) => !r.url.includes('well-known'))).toBe(true);
	});

	it('returns null when discovery finds nothing', async () => {
		stubFetch({});
		const provider = createOidcProvider({ AUTH_ISSUER: ISSUER })!;
		expect(await provider.verify('any.token.here', RESOURCE)).toBeNull();
	});

	it('rejects a token with no subject', async () => {
		const { pair, jwks } = await makeKey();
		stubFetch({ [JWKS_URL]: { body: jwks } });

		const provider = createOidcProvider({ AUTH_ISSUER: ISSUER, AUTH_JWKS_URL: JWKS_URL })!;
		const token = await sign(pair.privateKey, { ...claims(), sub: undefined });

		expect(await provider.verify(token, RESOURCE)).toBeNull();
	});

	it('honours an explicit audience over the resource URI', async () => {
		const { pair, jwks } = await makeKey();
		stubFetch({ [JWKS_URL]: { body: jwks } });

		const provider = createOidcProvider({
			AUTH_ISSUER: ISSUER,
			AUTH_JWKS_URL: JWKS_URL,
			AUTH_AUDIENCE: 'my-api'
		})!;
		const token = await sign(pair.privateKey, { ...claims(), aud: 'my-api' });

		expect((await provider.verify(token, RESOURCE))?.sub).toBe('user-9');
	});

	it('reads scopes from the token', async () => {
		const { pair, jwks } = await makeKey();
		stubFetch({ [JWKS_URL]: { body: jwks } });

		const provider = createOidcProvider({ AUTH_ISSUER: ISSUER, AUTH_JWKS_URL: JWKS_URL })!;
		const token = await sign(pair.privateKey, { ...claims(), scope: 'mcp:tools extra' });

		expect((await provider.verify(token, RESOURCE))?.scopes).toEqual(['mcp:tools', 'extra']);
	});
});

describe('Cloudflare Access provider', () => {
	const TEAM = 'acme.cloudflareaccess.com';
	const TEAM_URL = `https://${TEAM}`;
	const CERTS = `${TEAM_URL}/cdn-cgi/access/certs`;

	it('requires a team domain', () => {
		expect(createAccessProvider({})).toBeUndefined();
	});

	it('derives the issuer and certs URL from the team domain', () => {
		const provider = createAccessProvider({ ACCESS_TEAM_DOMAIN: TEAM })!;
		expect(provider.authorizationServers()).toEqual([TEAM_URL]);
	});

	it('accepts a team domain that already carries a scheme', () => {
		const provider = createAccessProvider({ ACCESS_TEAM_DOMAIN: TEAM_URL })!;
		expect(provider.authorizationServers()).toEqual([TEAM_URL]);
	});

	it('verifies a token against the team certs', async () => {
		const { pair, jwks } = await makeKey();
		stubFetch({ [CERTS]: { body: jwks } });

		const provider = createAccessProvider({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: 'app-tag' })!;
		const token = await sign(pair.privateKey, {
			iss: TEAM_URL,
			sub: 'user-9',
			aud: 'app-tag',
			exp: Math.floor(Date.now() / 1000) + 600
		});

		expect((await provider.verify(token, RESOURCE))?.sub).toBe('user-9');
	});

	it('falls back to the email claim when sub is absent', async () => {
		const { pair, jwks } = await makeKey();
		stubFetch({ [CERTS]: { body: jwks } });

		const provider = createAccessProvider({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: 'app-tag' })!;
		const token = await sign(pair.privateKey, {
			iss: TEAM_URL,
			aud: 'app-tag',
			email: 'user@acme.test',
			exp: Math.floor(Date.now() / 1000) + 600
		});

		expect((await provider.verify(token, RESOURCE))?.sub).toBe('user@acme.test');
	});

	it('rejects a token with neither sub nor email', async () => {
		const { pair, jwks } = await makeKey();
		stubFetch({ [CERTS]: { body: jwks } });

		const provider = createAccessProvider({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: 'app-tag' })!;
		const token = await sign(pair.privateKey, {
			iss: TEAM_URL,
			aud: 'app-tag',
			exp: Math.floor(Date.now() / 1000) + 600
		});

		expect(await provider.verify(token, RESOURCE)).toBeNull();
	});

	it('rejects a token for another Access application', async () => {
		const { pair, jwks } = await makeKey();
		stubFetch({ [CERTS]: { body: jwks } });

		const provider = createAccessProvider({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: 'app-tag' })!;
		const token = await sign(pair.privateKey, {
			iss: TEAM_URL,
			sub: 'user-9',
			aud: 'a-different-app',
			exp: Math.floor(Date.now() / 1000) + 600
		});

		expect(await provider.verify(token, RESOURCE)).toBeNull();
	});

	it('falls back to the configured scopes when the token carries none', async () => {
		const { pair, jwks } = await makeKey();
		stubFetch({ [CERTS]: { body: jwks } });

		const provider = createAccessProvider({
			ACCESS_TEAM_DOMAIN: TEAM,
			ACCESS_AUD: 'app-tag',
			AUTH_SCOPES: 'mcp:tools'
		})!;
		const token = await sign(pair.privateKey, {
			iss: TEAM_URL,
			sub: 'user-9',
			aud: 'app-tag',
			exp: Math.floor(Date.now() / 1000) + 600
		});

		expect((await provider.verify(token, RESOURCE))?.scopes).toEqual(['mcp:tools']);
	});
});
