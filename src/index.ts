import { getIdentityProvider } from './auth/identity';
import type { Principal } from './auth/identity';
import {
	PROTECTED_RESOURCE_PATH,
	authenticate,
	buildConnectUrl,
	canonicalResource,
	loadUpstreamCredentials,
	protectedResourceMetadata,
	readConnectState,
	schemeAuthorizationUrl,
	storeUpstreamCredential,
	unauthorized
} from './auth/resource';
import { readSuppliedCredentials } from './auth/upstream';
import type { Env } from './env';
import { authEnabled } from './env';
import type { McpContext } from './mcp/dispatch';
import {
	McpSseSession,
	messageEndpoint,
	openSseStream,
	pushToSession,
	sseUnavailable
} from './mcp/sse';
import { handleStreamableHttp } from './mcp/streamable';
import {
	ResolveError,
	credentialHosts,
	getToolTable,
	knownAliases,
	resolveBaseUrl,
	resolveServerToken
} from './resolve';
import type { ToolFilter } from './openapi/tools';
import type { ProtocolVersion } from './types';
import { JSONRPC_VERSION } from './types';

const CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
	'Access-Control-Allow-Headers':
		'Content-Type, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID, X-Mcp-Upstream-Authorization, *',
	'Access-Control-Expose-Headers': 'MCP-Protocol-Version, Mcp-Session-Id, WWW-Authenticate',
	'Access-Control-Max-Age': '86400'
};

const SECURITY_HEADERS: Record<string, string> = {
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'no-referrer',
	'X-Frame-Options': 'DENY'
};

function withHeaders(response: Response): Response {
	const headers = new Headers(response.headers);
	for (const [k, v] of Object.entries({ ...CORS_HEADERS, ...SECURITY_HEADERS })) {
		if (!headers.has(k)) headers.set(k, v);
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { 'Content-Type': 'application/json', ...extra }
	});
}

function rpcError(code: number, message: string, status: number): Response {
	return json({ jsonrpc: JSONRPC_VERSION, id: null, error: { code, message } }, status);
}

function csv(value: string | null): string[] | undefined {
	if (!value) return undefined;
	const parts = value
		.split(',')
		.map((v) => v.trim())
		.filter(Boolean);
	return parts.length ? parts : undefined;
}

function readFilter(url: URL): ToolFilter {
	const max = Number(url.searchParams.get('max'));
	return {
		tags: csv(url.searchParams.get('tags')),
		methods: csv(url.searchParams.get('methods'))?.map((m) => m.toLowerCase()),
		include: csv(url.searchParams.get('include')),
		exclude: csv(url.searchParams.get('exclude')),
		max: Number.isFinite(max) && max > 0 ? max : undefined,
		outputSchema: url.searchParams.get('outputSchema') === '0' ? false : undefined
	};
}

function readConfirmMethods(url: URL): Set<string> {
	const value = url.searchParams.get('confirm');
	if (!value) return new Set();
	if (value === 'write') return new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
	if (value === 'destructive') return new Set(['DELETE']);
	if (value === 'all') return new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
	return new Set(csv(value)?.map((m) => m.toUpperCase()) ?? []);
}

/**
 * Splits the request path on the RAW pathname.
 *
 * The server token is one percent-encoded segment, so it is decoded exactly once here and the
 * remainder is kept verbatim. Reconstructing this by string replacement is what made every
 * URL-encoded description unreachable.
 */
export function splitPath(pathname: string): { token: string; rest: string } | undefined {
	const segments = pathname.split('/');
	const first = segments[1];
	if (!first) return undefined;

	let token: string;
	try {
		token = decodeURIComponent(first);
	} catch {
		token = first;
	}

	const rest = segments.length > 2 ? `/${segments.slice(2).join('/')}` : '/';
	return { token, rest };
}

function landing(url: URL): Response {
	return json({
		name: 'MyMCP',
		description: 'Turns any OpenAPI description into an MCP server.',
		usage: {
			streamableHttp: `${url.origin}/{server}/mcp`,
			deprecatedSse: `${url.origin}/{server}/sse`,
			example: `${url.origin}/petstore/mcp`
		},
		servers: knownAliases(),
		filters: ['tags', 'methods', 'include', 'exclude', 'max', 'server', 'confirm', 'outputSchema'],
		protocolVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
	});
}

async function buildMcpHandler(
	request: Request,
	url: URL,
	env: Env,
	token: string,
	principal: Principal | undefined,
	waitUntil: (promise: Promise<unknown>) => void
) {
	const specUrl = resolveServerToken(token, env);
	const filter = readFilter(url);
	const { table, sourceUrl } = await getToolTable(specUrl, filter, env);

	const serverIndex = Number(url.searchParams.get('server'));
	const baseUrl = resolveBaseUrl(
		table,
		sourceUrl,
		Number.isInteger(serverIndex) && serverIndex >= 0 ? serverIndex : 0
	);

	const hosts = credentialHosts(table, sourceUrl, env);
	const supplied = readSuppliedCredentials(request.headers);

	const upstreamHost = (() => {
		try {
			return new URL(baseUrl).host.toLowerCase();
		} catch {
			return '';
		}
	})();

	const stored = await loadUpstreamCredentials(
		env,
		principal,
		upstreamHost,
		Object.keys(table.securitySchemes)
	);

	const confirmMethods = readConfirmMethods(url);

	return (protocol: ProtocolVersion, clientCapabilities: Record<string, any>): McpContext => ({
		env,
		table,
		sourceUrl,
		baseUrl,
		credentialHosts: hosts,
		supplied,
		protocol,
		clientCapabilities,
		filter,
		confirmMethods,
		principal: principal?.sub,
		storedCredentials: stored,
		connectUrl: principal
			? (schemes: string[]) => {
					const scheme = schemes[0] ?? 'default';
					// sealed synchronously below is not possible, so the caller gets a stable path
					return `${url.origin}/connect?server=${encodeURIComponent(token)}&scheme=${encodeURIComponent(scheme)}`;
				}
			: undefined,
		waitUntil
	});
}

async function handleConnect(
	request: Request,
	url: URL,
	env: Env,
	principal: Principal | undefined
): Promise<Response> {
	if (!principal) return unauthorized(url, [], 'Sign in before connecting an upstream API');

	const stateParam = url.searchParams.get('state');
	if (stateParam) {
		const state = await readConnectState(env, stateParam, principal);
		if (!state) return json({ error: 'The connect link is invalid or has expired' }, 400);
	}

	const token = url.searchParams.get('server');
	const schemeName = url.searchParams.get('scheme') ?? '';
	if (!token) return json({ error: 'A server is required' }, 400);

	const specUrl = resolveServerToken(token, env);
	const { table, sourceUrl } = await getToolTable(specUrl, {}, env);
	const baseUrl = resolveBaseUrl(table, sourceUrl);
	const host = new URL(baseUrl).host.toLowerCase();

	const scheme = table.securitySchemes[schemeName];
	const authorizationUrl = schemeAuthorizationUrl(scheme);

	if (!authorizationUrl) {
		return new Response(
			`<!doctype html><meta charset="utf-8"><title>Connect</title>` +
				`<p>This API does not describe an OAuth flow. Supply a credential with the ` +
				`<code>X-Mcp-Upstream-Authorization</code> header instead.</p>`,
			{ status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
		);
	}

	// bind the callback to this principal so another user cannot complete the flow in their place
	const state = await buildConnectUrl(env, url, principal, token, host, schemeName);
	const sealed = new URL(state).searchParams.get('state') ?? '';

	const redirect = new URL(authorizationUrl);
	redirect.searchParams.set('response_type', 'code');
	redirect.searchParams.set('redirect_uri', `${url.origin}/connect/callback`);
	redirect.searchParams.set('state', sealed);

	return new Response(null, { status: 302, headers: { Location: redirect.toString() } });
}

async function handleConnectCallback(
	url: URL,
	env: Env,
	principal: Principal | undefined
): Promise<Response> {
	if (!principal) return unauthorized(url, [], 'Sign in to finish connecting');

	const stateParam = url.searchParams.get('state') ?? '';
	const state = await readConnectState(env, stateParam, principal);
	if (!state) return json({ error: 'The authorization state is invalid or has expired' }, 400);

	const code = url.searchParams.get('code');
	if (!code) return json({ error: url.searchParams.get('error') ?? 'No authorization code' }, 400);

	// the code is stored as the upstream credential; exchanging it needs client registration
	// with the upstream, which is deployment-specific configuration
	await storeUpstreamCredential(env, principal.sub, state.host, state.scheme, code);

	return new Response(
		`<!doctype html><meta charset="utf-8"><title>Connected</title>` +
			`<p>Connected to ${state.host}. Return to your MCP client and retry the request.</p>`,
		{ headers: { 'Content-Type': 'text/html; charset=utf-8' } }
	);
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);

	if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

	const provider = authEnabled(env) ? getIdentityProvider(env) : undefined;

	if (provider?.handle) {
		const handled = await provider.handle(request, url, env);
		if (handled) return handled;
	}

	if (url.pathname === PROTECTED_RESOURCE_PATH) {
		if (!provider) return json({ error: 'Authorization is not enabled on this deployment' }, 404);
		return protectedResourceMetadata(url, provider, canonicalResource(url));
	}

	if (url.pathname === '/' || url.pathname === '') return landing(url);
	if (url.pathname === '/favicon.ico' || url.pathname === '/favicon.svg') {
		return env.ASSETS ? env.ASSETS.fetch(request) : new Response(null, { status: 404 });
	}

	let principal: Principal | undefined;
	if (provider) {
		principal = (await authenticate(request, url, provider)) ?? undefined;
	}

	if (url.pathname === '/connect') return handleConnect(request, url, env, principal);
	if (url.pathname === '/connect/callback') return handleConnectCallback(url, env, principal);

	const split = splitPath(url.pathname);
	if (!split) return landing(url);

	// MCP endpoints require authorization when a provider is configured
	if (provider && !principal) {
		return unauthorized(url, provider.scopesSupported());
	}

	const waitUntil = (promise: Promise<unknown>) => ctx.waitUntil(promise);

	try {
		const buildContext = await buildMcpHandler(
			request,
			url,
			env,
			split.token,
			principal,
			waitUntil
		);

		const rest = split.rest.replace(/\/$/, '') || '/';

		if (rest === '/mcp' || rest === '/') {
			return handleStreamableHttp(request, {
				strictHeaders: env.MCP_STRICT_HEADERS !== '0',
				buildContext
			});
		}

		if (rest === '/sse') {
			if (request.method === 'POST') {
				// existing deployments POST JSON-RPC here; keep that working
				return handleStreamableHttp(request, {
					strictHeaders: false,
					buildContext
				});
			}
			if (request.method !== 'GET') {
				return rpcError(-32600, 'The SSE endpoint accepts GET or POST', 405);
			}
			if (!env.MCP_SSE) return sseUnavailable(`${url.origin}/${split.token}/mcp`);
			return openSseStream(env.MCP_SSE, url);
		}

		if (rest === '/messages') {
			if (request.method !== 'POST') {
				return rpcError(-32600, 'The message endpoint accepts POST', 405);
			}
			if (!env.MCP_SSE) return sseUnavailable(`${url.origin}/${split.token}/mcp`);

			const sessionId = url.searchParams.get('sessionId');
			if (!sessionId) return rpcError(-32600, 'A sessionId is required', 400);

			const response = await handleStreamableHttp(request, {
				strictHeaders: false,
				buildContext
			});

			if (response.status === 202) return new Response(null, { status: 202 });

			const payload = await response.json();
			const delivered = await pushToSession(env.MCP_SSE, sessionId, payload);
			if (!delivered) return rpcError(-32600, 'No open SSE stream for that session', 409);

			return new Response(null, { status: 202 });
		}

		return json(
			{
				error: 'Unknown endpoint',
				endpoints: [`/${split.token}/mcp`, `/${split.token}/sse`, `/${split.token}/messages`]
			},
			404
		);
	} catch (error) {
		if (error instanceof ResolveError) {
			return json({ error: error.message, reason: error.reason }, error.status);
		}
		const message = error instanceof Error ? error.message : 'Unknown error';
		console.error(`[error] ${request.method} ${url.pathname}: ${message}`);
		return json({ error: 'Failed to build the MCP server', message }, 500);
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return withHeaders(await route(request, env, ctx));
	}
} satisfies ExportedHandler<Env>;

export { McpSseSession, messageEndpoint };
