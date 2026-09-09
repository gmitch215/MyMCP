import type { Env } from '../../env';
import { fromBase64Url, toBase64Url } from '../../state';
import type { IdentityProvider, Principal } from './index';
import { DEFAULT_SCOPES, parseScopes } from './index';

const CODE_TTL_SEC = 300;
const TOKEN_TTL_SEC = 3600;
const REFRESH_TTL_SEC = 30 * 24 * 3600;

interface CodeRecord {
	clientId: string;
	redirectUri: string;
	challenge: string;
	scope: string;
	sub: string;
	resource?: string;
}

interface TokenRecord {
	sub: string;
	scope: string;
	clientId: string;
	resource?: string;
}

function randomToken(): string {
	return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256Base64Url(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return toBase64Url(new Uint8Array(digest));
}

/** constant-time comparison so a wrong password cannot be found by timing */
function timingSafeEqual(a: string, b: string): boolean {
	const left = new TextEncoder().encode(a);
	const right = new TextEncoder().encode(b);
	if (left.length !== right.length) return false;

	let diff = 0;
	for (let i = 0; i < left.length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
	return diff === 0;
}

/**
 * Client ID Metadata Documents: the client_id is an https URL that serves the client's own
 * metadata, which replaces Dynamic Client Registration in the current specification.
 */
async function resolveClient(clientId: string): Promise<{ redirectUris: string[] } | undefined> {
	if (!/^https:\/\//i.test(clientId)) return undefined;

	try {
		const response = await fetch(clientId, { headers: { Accept: 'application/json' } });
		if (!response.ok) return undefined;

		const doc = (await response.json()) as { client_id?: string; redirect_uris?: unknown };
		if (doc.client_id !== clientId) return undefined;

		const uris = Array.isArray(doc.redirect_uris)
			? doc.redirect_uris.filter((u): u is string => typeof u === 'string')
			: [];
		return uris.length ? { redirectUris: uris } : undefined;
	} catch {
		return undefined;
	}
}

function loginPage(params: URLSearchParams, error?: string): Response {
	const hidden = [...params.entries()]
		.map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
		.join('');

	const body = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign In</title>
<style>body{font-family:system-ui,sans-serif;max-width:22rem;margin:4rem auto;padding:0 1rem}
label{display:block;margin:1rem 0 .25rem}input[type=password]{width:100%;padding:.5rem;font-size:1rem}
button{margin-top:1rem;padding:.5rem 1rem;font-size:1rem}.error{color:#b00}</style></head>
<body><h1>Sign In</h1>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<form method="post">${hidden}
<label for="password">Password</label>
<input id="password" type="password" name="password" autocomplete="current-password" required>
<button type="submit">Continue</button></form></body></html>`;

	return new Response(body, {
		status: error ? 401 : 200,
		headers: { 'Content-Type': 'text/html; charset=utf-8' }
	});
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** reads a form-encoded body without tripping the runtime's text-decoding warning */
async function readForm(request: Request): Promise<URLSearchParams> {
	const type = request.headers.get('content-type') ?? '';
	if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
		const form = await request.formData();
		const params = new URLSearchParams();
		for (const [key, value] of form) if (typeof value === 'string') params.append(key, value);
		return params;
	}
	return new URLSearchParams(await request.text());
}

function oauthError(error: string, description: string, status = 400): Response {
	return new Response(JSON.stringify({ error, error_description: description }), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

/**
 * A minimal OAuth 2.1 authorization server running inside the Worker.
 *
 * Intended for a single-operator deployment: the operator password authenticates the one
 * principal. PKCE is mandatory and tokens are opaque, verified by a KV lookup.
 */
export function createSelfHostedProvider(env: Env): IdentityProvider | undefined {
	if (!env.MYMCP_KV) return undefined;

	const scopes = parseScopes(env.AUTH_SCOPES, DEFAULT_SCOPES);
	const kv = env.MYMCP_KV;

	return {
		name: 'selfhosted',

		authorizationServers() {
			return env.AUTH_ISSUER ? [env.AUTH_ISSUER] : [];
		},

		scopesSupported() {
			return scopes;
		},

		async verify(token: string, resource: string): Promise<Principal | null> {
			const raw = await kv.get(`oauth:token:${token}`);
			if (!raw) return null;

			try {
				const record = JSON.parse(raw) as TokenRecord;
				if (record.resource && record.resource !== resource) return null;
				return { sub: record.sub, scopes: record.scope.split(' ').filter(Boolean) };
			} catch {
				return null;
			}
		},

		async handle(request: Request, url: URL): Promise<Response | undefined> {
			const issuer = env.AUTH_ISSUER ?? url.origin;

			if (url.pathname === '/.well-known/oauth-authorization-server') {
				return new Response(
					JSON.stringify({
						issuer,
						authorization_endpoint: `${issuer}/oauth/authorize`,
						token_endpoint: `${issuer}/oauth/token`,
						scopes_supported: scopes,
						response_types_supported: ['code'],
						grant_types_supported: ['authorization_code', 'refresh_token'],
						code_challenge_methods_supported: ['S256'],
						token_endpoint_auth_methods_supported: ['none'],
						authorization_response_iss_parameter_supported: true
					}),
					{ headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600' } }
				);
			}

			if (url.pathname === '/oauth/authorize')
				return authorize(request, url, env, kv, issuer, scopes);
			if (url.pathname === '/oauth/token') return token(request, kv, issuer);

			return undefined;
		}
	};
}

async function authorize(
	request: Request,
	url: URL,
	env: Env,
	kv: KVNamespace,
	issuer: string,
	scopes: string[]
): Promise<Response> {
	const params = request.method === 'POST' ? await readForm(request) : url.searchParams;

	const clientId = params.get('client_id') ?? '';
	const redirectUri = params.get('redirect_uri') ?? '';
	const challenge = params.get('code_challenge') ?? '';
	const method = params.get('code_challenge_method') ?? '';
	const state = params.get('state') ?? '';
	const resource = params.get('resource') ?? undefined;
	const scope = params.get('scope') ?? scopes.join(' ');

	if (params.get('response_type') !== 'code') {
		return oauthError('unsupported_response_type', 'Only the authorization code flow is supported');
	}
	if (!challenge || method !== 'S256') {
		return oauthError('invalid_request', 'PKCE with code_challenge_method=S256 is required');
	}

	const client = await resolveClient(clientId);
	if (!client) {
		return oauthError(
			'invalid_client',
			'client_id must be an https URL serving a Client ID Metadata Document'
		);
	}
	if (!client.redirectUris.includes(redirectUri)) {
		return oauthError('invalid_request', 'redirect_uri is not registered for this client');
	}

	const password = env.SELFHOST_PASSWORD;
	if (!password) {
		return oauthError('server_error', 'SELFHOST_PASSWORD is not configured', 500);
	}

	if (request.method !== 'POST') {
		const carried = new URLSearchParams(url.searchParams);
		return loginPage(carried);
	}

	const supplied = params.get('password') ?? '';
	if (!timingSafeEqual(supplied, password)) {
		const carried = new URLSearchParams(params);
		carried.delete('password');
		return loginPage(carried, 'Incorrect password.');
	}

	const code = randomToken();
	const record: CodeRecord = {
		clientId,
		redirectUri,
		challenge,
		scope,
		sub: 'operator',
		resource
	};
	await kv.put(`oauth:code:${code}`, JSON.stringify(record), { expirationTtl: CODE_TTL_SEC });

	const location = new URL(redirectUri);
	location.searchParams.set('code', code);
	location.searchParams.set('iss', issuer);
	if (state) location.searchParams.set('state', state);

	return new Response(null, { status: 302, headers: { Location: location.toString() } });
}

async function token(request: Request, kv: KVNamespace, issuer: string): Promise<Response> {
	if (request.method !== 'POST') {
		return oauthError('invalid_request', 'The token endpoint accepts POST', 405);
	}

	const params = await readForm(request);
	const grantType = params.get('grant_type');

	if (grantType === 'refresh_token') {
		const refresh = params.get('refresh_token') ?? '';
		const raw = await kv.get(`oauth:refresh:${refresh}`);
		if (!raw) return oauthError('invalid_grant', 'The refresh token is not valid');

		const record = JSON.parse(raw) as TokenRecord;
		return issueTokens(kv, record, issuer);
	}

	if (grantType !== 'authorization_code') {
		return oauthError('unsupported_grant_type', `Unsupported grant_type: ${String(grantType)}`);
	}

	const code = params.get('code') ?? '';
	const verifier = params.get('code_verifier') ?? '';
	const redirectUri = params.get('redirect_uri') ?? '';
	const clientId = params.get('client_id') ?? '';

	const raw = await kv.get(`oauth:code:${code}`);
	if (!raw) return oauthError('invalid_grant', 'The authorization code is not valid');

	// codes are single use, so consume before any further checks
	await kv.delete(`oauth:code:${code}`);

	const record = JSON.parse(raw) as CodeRecord;
	if (record.clientId !== clientId || record.redirectUri !== redirectUri) {
		return oauthError('invalid_grant', 'The code was issued to a different client or redirect URI');
	}

	if ((await sha256Base64Url(verifier)) !== record.challenge) {
		return oauthError('invalid_grant', 'The PKCE verifier does not match the challenge');
	}

	return issueTokens(
		kv,
		{ sub: record.sub, scope: record.scope, clientId: record.clientId, resource: record.resource },
		issuer
	);
}

async function issueTokens(
	kv: KVNamespace,
	record: TokenRecord,
	issuer: string
): Promise<Response> {
	const accessToken = randomToken();
	const refreshToken = randomToken();

	await kv.put(`oauth:token:${accessToken}`, JSON.stringify(record), {
		expirationTtl: TOKEN_TTL_SEC
	});
	await kv.put(`oauth:refresh:${refreshToken}`, JSON.stringify(record), {
		expirationTtl: REFRESH_TTL_SEC
	});

	return new Response(
		JSON.stringify({
			access_token: accessToken,
			token_type: 'Bearer',
			expires_in: TOKEN_TTL_SEC,
			refresh_token: refreshToken,
			scope: record.scope,
			issuer
		}),
		{ headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
	);
}

export { fromBase64Url };
