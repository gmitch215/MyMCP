import type { Env } from '../env';
import { seal, unseal } from '../state';
import type { SecurityScheme } from '../types';
import type { IdentityProvider, Principal } from './identity';

export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';

/** the canonical resource URI a token must be audience-bound to */
export function canonicalResource(url: URL): string {
	return `${url.origin}${url.pathname}`.replace(/\/$/, '');
}

export function protectedResourceMetadata(
	url: URL,
	provider: IdentityProvider,
	resource: string
): Response {
	return new Response(
		JSON.stringify({
			resource,
			authorization_servers: provider.authorizationServers(),
			scopes_supported: provider.scopesSupported(),
			bearer_methods_supported: ['header'],
			resource_documentation: `${url.origin}/`
		}),
		{
			headers: {
				'Content-Type': 'application/json',
				'Cache-Control': 'public, max-age=3600',
				'Access-Control-Allow-Origin': '*'
			}
		}
	);
}

function metadataUrl(url: URL): string {
	return `${url.origin}${PROTECTED_RESOURCE_PATH}`;
}

export function unauthorized(url: URL, scopes: string[], description?: string): Response {
	const challenge = [
		`Bearer resource_metadata="${metadataUrl(url)}"`,
		scopes.length ? `scope="${scopes.join(' ')}"` : '',
		description ? `error_description="${description.replace(/"/g, "'")}"` : ''
	]
		.filter(Boolean)
		.join(', ');

	return new Response(
		JSON.stringify({
			jsonrpc: '2.0',
			id: null,
			error: { code: -32001, message: description ?? 'Authorization required' }
		}),
		{
			status: 401,
			headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': challenge }
		}
	);
}

/** all scopes needed for the operation go in one challenge, so one round trip suffices */
export function insufficientScope(url: URL, required: string[]): Response {
	const challenge = [
		'Bearer error="insufficient_scope"',
		`scope="${required.join(' ')}"`,
		`resource_metadata="${metadataUrl(url)}"`
	].join(', ');

	return new Response(
		JSON.stringify({
			jsonrpc: '2.0',
			id: null,
			error: { code: -32001, message: `Missing required scope: ${required.join(' ')}` }
		}),
		{
			status: 403,
			headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': challenge }
		}
	);
}

export function bearerToken(request: Request): string | undefined {
	const header = request.headers.get('authorization');
	if (!header) return undefined;

	const match = header.match(/^Bearer\s+(.+)$/i);
	return match?.[1]?.trim() || undefined;
}

export async function authenticate(
	request: Request,
	url: URL,
	provider: IdentityProvider
): Promise<Principal | null> {
	const token = bearerToken(request);
	if (!token) return null;
	return provider.verify(token, canonicalResource(url));
}

// #region upstream token storage

interface StoredToken {
	value: string;
	expiresAt?: number;
}

function upstreamKey(sub: string, host: string, scheme: string): string {
	return `upstream:${sub}:${host}:${scheme}`;
}

/**
 * Upstream credentials obtained on the user's behalf, bound to their verified identity.
 * These never travel to the MCP client, which is what keeps this out of token passthrough.
 */
export async function loadUpstreamCredentials(
	env: Env,
	principal: Principal | undefined,
	host: string,
	schemeNames: string[]
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	if (!env.MYMCP_KV || !principal) return out;

	for (const scheme of schemeNames) {
		const raw = await env.MYMCP_KV.get(upstreamKey(principal.sub, host, scheme));
		if (!raw) continue;

		try {
			const stored = JSON.parse(raw) as StoredToken;
			if (stored.expiresAt && stored.expiresAt < Date.now()) continue;
			out.set(scheme, stored.value);
		} catch {
			// a malformed record is treated as absent
		}
	}
	return out;
}

export async function storeUpstreamCredential(
	env: Env,
	sub: string,
	host: string,
	scheme: string,
	value: string,
	expiresInSec?: number
): Promise<void> {
	if (!env.MYMCP_KV) return;

	const record: StoredToken = {
		value,
		expiresAt: expiresInSec ? Date.now() + expiresInSec * 1000 : undefined
	};
	await env.MYMCP_KV.put(upstreamKey(sub, host, scheme), JSON.stringify(record), {
		expirationTtl: expiresInSec ? Math.max(60, expiresInSec) : undefined
	});
}

// #endregion

// #region third-party connect flow

export interface ConnectState {
	sub: string;
	host: string;
	scheme: string;
	server: string;
	returnTo?: string;
}

const CONNECT_TTL_MS = 15 * 60 * 1000;

export async function buildConnectUrl(
	env: Env,
	url: URL,
	principal: Principal,
	server: string,
	host: string,
	scheme: string
): Promise<string> {
	const state = await seal<ConnectState>(
		env,
		{ sub: principal.sub, host, scheme, server },
		CONNECT_TTL_MS,
		principal.sub
	);
	return `${url.origin}/connect?state=${encodeURIComponent(state)}`;
}

export async function readConnectState(
	env: Env,
	token: string,
	principal: Principal
): Promise<ConnectState | null> {
	return unseal<ConnectState>(env, token, { principal: principal.sub });
}

/** the authorization endpoint of an OAuth2 security scheme, when it declares one */
export function schemeAuthorizationUrl(scheme: SecurityScheme | undefined): string | undefined {
	if (!scheme?.flows) return undefined;

	for (const flow of Object.values(scheme.flows)) {
		if (flow?.authorizationUrl) return flow.authorizationUrl;
	}
	return undefined;
}

// #endregion
