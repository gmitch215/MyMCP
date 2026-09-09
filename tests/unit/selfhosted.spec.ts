import { env as testEnv } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getIdentityProvider } from '../../src/auth/identity';
import type { Env } from '../../src/env';
import { toBase64Url } from '../../src/state';
import { stubFetch } from '../helpers';

const CLIENT_ID = 'https://client.example/metadata.json';
const REDIRECT_URI = 'https://client.example/callback';
const ISSUER = 'https://mymcp.test';

const env: Env = {
	...(testEnv as unknown as Env),
	AUTH_PROVIDER: 'selfhosted',
	AUTH_ISSUER: ISSUER,
	SELFHOST_PASSWORD: 'correct horse battery staple'
};

const clientMetadata = JSON.stringify({
	client_id: CLIENT_ID,
	redirect_uris: [REDIRECT_URI],
	application_type: 'native'
});

async function pkce(): Promise<{ verifier: string; challenge: string }> {
	const verifier = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return { verifier, challenge: toBase64Url(new Uint8Array(digest)) };
}

function provider() {
	const found = getIdentityProvider(env);
	if (!found?.handle) throw new Error('self-hosted provider not available');
	return found;
}

function authorizeUrl(challenge: string): URL {
	const url = new URL(`${ISSUER}/oauth/authorize`);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', CLIENT_ID);
	url.searchParams.set('redirect_uri', REDIRECT_URI);
	url.searchParams.set('code_challenge', challenge);
	url.searchParams.set('code_challenge_method', 'S256');
	url.searchParams.set('state', 'client-state');
	url.searchParams.set('resource', `${ISSUER}/petstore/mcp`);
	return url;
}

async function submitLogin(challenge: string, password: string): Promise<Response> {
	const url = authorizeUrl(challenge);
	const form = new URLSearchParams(url.searchParams);
	form.set('password', password);

	const request = new Request(url.toString(), {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: form.toString()
	});
	return (await provider().handle!(request, new URL(request.url), env))!;
}

async function exchange(code: string, verifier: string): Promise<Response> {
	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		code,
		code_verifier: verifier,
		redirect_uri: REDIRECT_URI,
		client_id: CLIENT_ID
	});

	const request = new Request(`${ISSUER}/oauth/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: body.toString()
	});
	return (await provider().handle!(request, new URL(request.url), env))!;
}

afterEach(() => vi.unstubAllGlobals());

describe('authorization server metadata', () => {
	it('advertises PKCE and the endpoints', async () => {
		const request = new Request(`${ISSUER}/.well-known/oauth-authorization-server`);
		const response = (await provider().handle!(request, new URL(request.url), env))!;
		const body = (await response.json()) as any;

		expect(body.issuer).toBe(ISSUER);
		expect(body.code_challenge_methods_supported).toEqual(['S256']);
		expect(body.grant_types_supported).toContain('authorization_code');
		expect(body.authorization_response_iss_parameter_supported).toBe(true);
	});
});

describe('authorization code flow', () => {
	it('completes a full PKCE exchange', async () => {
		stubFetch({ [CLIENT_ID]: { body: clientMetadata } });
		const { verifier, challenge } = await pkce();

		const redirect = await submitLogin(challenge, env.SELFHOST_PASSWORD!);
		expect(redirect.status).toBe(302);

		const location = new URL(redirect.headers.get('Location')!);
		expect(location.searchParams.get('state')).toBe('client-state');
		expect(location.searchParams.get('iss')).toBe(ISSUER);

		const code = location.searchParams.get('code')!;
		const tokens = (await (await exchange(code, verifier)).json()) as any;

		expect(tokens.token_type).toBe('Bearer');
		expect(typeof tokens.access_token).toBe('string');
		expect(typeof tokens.refresh_token).toBe('string');
	});

	it('issues a token that verifies for the bound resource', async () => {
		stubFetch({ [CLIENT_ID]: { body: clientMetadata } });
		const { verifier, challenge } = await pkce();

		const redirect = await submitLogin(challenge, env.SELFHOST_PASSWORD!);
		const code = new URL(redirect.headers.get('Location')!).searchParams.get('code')!;
		const tokens = (await (await exchange(code, verifier)).json()) as any;

		const principal = await provider().verify(tokens.access_token, `${ISSUER}/petstore/mcp`);
		expect(principal?.sub).toBe('operator');
	});

	it('rejects a token presented for a different resource', async () => {
		stubFetch({ [CLIENT_ID]: { body: clientMetadata } });
		const { verifier, challenge } = await pkce();

		const redirect = await submitLogin(challenge, env.SELFHOST_PASSWORD!);
		const code = new URL(redirect.headers.get('Location')!).searchParams.get('code')!;
		const tokens = (await (await exchange(code, verifier)).json()) as any;

		expect(await provider().verify(tokens.access_token, 'https://elsewhere.test/mcp')).toBeNull();
	});

	it('shows a login form on GET', async () => {
		stubFetch({ [CLIENT_ID]: { body: clientMetadata } });
		const { challenge } = await pkce();

		const request = new Request(authorizeUrl(challenge).toString());
		const response = (await provider().handle!(request, new URL(request.url), env))!;

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('text/html');
		expect(await response.text()).toContain('type="password"');
	});

	it('rejects a wrong password', async () => {
		stubFetch({ [CLIENT_ID]: { body: clientMetadata } });
		const { challenge } = await pkce();

		const response = await submitLogin(challenge, 'wrong');
		expect(response.status).toBe(401);
		expect(await response.text()).toContain('Incorrect password');
	});

	it('requires PKCE with S256', async () => {
		stubFetch({ [CLIENT_ID]: { body: clientMetadata } });

		const url = authorizeUrl('challenge');
		url.searchParams.set('code_challenge_method', 'plain');
		const request = new Request(url.toString());
		const response = (await provider().handle!(request, new URL(request.url), env))!;

		expect(response.status).toBe(400);
		expect(((await response.json()) as { error?: string }).error).toBe('invalid_request');
	});

	it('rejects a client_id that is not an https metadata document', async () => {
		const url = authorizeUrl('challenge');
		url.searchParams.set('client_id', 'not-a-url');
		url.searchParams.set('code_challenge_method', 'S256');

		const request = new Request(url.toString());
		const response = (await provider().handle!(request, new URL(request.url), env))!;

		expect(response.status).toBe(400);
		expect(((await response.json()) as { error?: string }).error).toBe('invalid_client');
	});

	it('rejects a redirect_uri the client document does not list', async () => {
		stubFetch({ [CLIENT_ID]: { body: clientMetadata } });
		const { challenge } = await pkce();

		const url = authorizeUrl(challenge);
		url.searchParams.set('redirect_uri', 'https://evil.example/steal');
		const request = new Request(url.toString());
		const response = (await provider().handle!(request, new URL(request.url), env))!;

		expect(response.status).toBe(400);
		expect(((await response.json()) as { error_description?: string }).error_description).toContain(
			'not registered'
		);
	});

	it('rejects a client document whose client_id does not match', async () => {
		stubFetch({
			[CLIENT_ID]: {
				body: JSON.stringify({
					client_id: 'https://other.example/x',
					redirect_uris: [REDIRECT_URI]
				})
			}
		});
		const { challenge } = await pkce();

		const url = authorizeUrl(challenge);
		const request = new Request(url.toString());
		const response = (await provider().handle!(request, new URL(request.url), env))!;

		expect(((await response.json()) as { error?: string }).error).toBe('invalid_client');
	});
});

describe('token endpoint', () => {
	it('rejects a mismatched PKCE verifier', async () => {
		stubFetch({ [CLIENT_ID]: { body: clientMetadata } });
		const { challenge } = await pkce();
		const other = await pkce();

		const redirect = await submitLogin(challenge, env.SELFHOST_PASSWORD!);
		const code = new URL(redirect.headers.get('Location')!).searchParams.get('code')!;

		const response = await exchange(code, other.verifier);
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error_description?: string }).error_description).toContain(
			'PKCE'
		);
	});

	it('consumes a code so it cannot be replayed', async () => {
		stubFetch({ [CLIENT_ID]: { body: clientMetadata } });
		const { verifier, challenge } = await pkce();

		const redirect = await submitLogin(challenge, env.SELFHOST_PASSWORD!);
		const code = new URL(redirect.headers.get('Location')!).searchParams.get('code')!;

		expect((await exchange(code, verifier)).status).toBe(200);
		expect((await exchange(code, verifier)).status).toBe(400);
	});

	it('rejects an unknown code', async () => {
		const response = await exchange('never-issued', 'whatever');
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error?: string }).error).toBe('invalid_grant');
	});

	it('rejects an unsupported grant type', async () => {
		const request = new Request(`${ISSUER}/oauth/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'grant_type=password&username=x&password=y'
		});
		const response = (await provider().handle!(request, new URL(request.url), env))!;

		expect(((await response.json()) as { error?: string }).error).toBe('unsupported_grant_type');
	});

	it('rejects GET on the token endpoint', async () => {
		const request = new Request(`${ISSUER}/oauth/token`);
		const response = (await provider().handle!(request, new URL(request.url), env))!;
		expect(response.status).toBe(405);
	});

	it('exchanges a refresh token for a new access token', async () => {
		stubFetch({ [CLIENT_ID]: { body: clientMetadata } });
		const { verifier, challenge } = await pkce();

		const redirect = await submitLogin(challenge, env.SELFHOST_PASSWORD!);
		const code = new URL(redirect.headers.get('Location')!).searchParams.get('code')!;
		const first = (await (await exchange(code, verifier)).json()) as any;

		const request = new Request(`${ISSUER}/oauth/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: first.refresh_token
			}).toString()
		});
		const refreshed = (await (await provider().handle!(
			request,
			new URL(request.url),
			env
		))!.json()) as any;

		expect(refreshed.access_token).toBeDefined();
		expect(refreshed.access_token).not.toBe(first.access_token);
	});
});

describe('configuration', () => {
	it('reports a server error when no operator password is set', async () => {
		stubFetch({ [CLIENT_ID]: { body: clientMetadata } });
		const { challenge } = await pkce();

		const withoutPassword = { ...env, SELFHOST_PASSWORD: undefined };
		const found = getIdentityProvider(withoutPassword)!;

		const url = authorizeUrl(challenge);
		const form = new URLSearchParams(url.searchParams);
		form.set('password', 'anything');

		const request = new Request(url.toString(), {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: form.toString()
		});
		const response = (await found.handle!(request, new URL(request.url), withoutPassword))!;

		expect(response.status).toBe(500);
	});

	it('leaves unrelated paths to the rest of the worker', async () => {
		const request = new Request(`${ISSUER}/petstore/mcp`);
		expect(await provider().handle!(request, new URL(request.url), env)).toBeUndefined();
	});
});
