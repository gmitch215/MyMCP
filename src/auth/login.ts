import type { CallOptions } from '../openapi/call';
import { executeCall } from '../openapi/call';
import type { SecurityScheme, ToolDefinition } from '../types';
import type { SuppliedCredentials } from './upstream';

/** the operation that trades a username and password for a token, and where the token goes */
export interface LoginRecipe {
	operationId: string;
	/** dot path to the token in the login response */
	token: string;
	/** security scheme the token fills */
	scheme: string;
}

export interface LoginCredentials {
	username: string;
	password: string;
}

export type LoginSetup =
	| {
			tool: ToolDefinition;
			recipe: LoginRecipe;
			scheme: SecurityScheme;
			credentials: LoginCredentials;
	  }
	| { error: string };

const DEFAULT_TOKEN_PATH = 'token';
const MAX_CACHED_TOKENS = 256;

// ponytail: per-isolate memory only; tokens vanish on eviction and concurrent misses each log in
const tokens = new Map<string, string>();

/**
 * Merges the `?login`, `?loginToken` and `?loginScheme` query parameters over an alias's recipe.
 * The scheme defaults to the description's only security scheme, when it has exactly one.
 */
export function readLoginRecipe(
	url: URL,
	alias: Partial<LoginRecipe> | undefined,
	schemeNames: string[]
): LoginRecipe | undefined {
	const operationId = url.searchParams.get('login') || alias?.operationId;
	if (!operationId) return undefined;

	return {
		operationId,
		token: url.searchParams.get('loginToken') || alias?.token || DEFAULT_TOKEN_PATH,
		scheme:
			url.searchParams.get('loginScheme') ||
			alias?.scheme ||
			(schemeNames.length === 1 ? schemeNames[0]! : '')
	};
}

/** checks a recipe against the tool table and the hosts allowed to receive credentials */
export function prepareLogin(
	recipe: LoginRecipe | undefined,
	credentials: LoginCredentials | undefined,
	tool: ToolDefinition | undefined,
	schemes: Record<string, SecurityScheme>,
	baseUrl: string,
	credentialHosts: Set<string>
): LoginSetup | undefined {
	if (!credentials) return undefined;
	if (!recipe) {
		return {
			error:
				'X-Mcp-Upstream-Login-* headers were sent, but this server has no login recipe. ' +
				'Add ?login=<operationId> to the MCP URL.'
		};
	}
	if (!tool) {
		return { error: `The login operation ${recipe.operationId} is not in this description.` };
	}

	const scheme = schemes[recipe.scheme];
	if (!scheme) {
		const known = Object.keys(schemes).join(', ') || 'none';
		return {
			error: `Login needs ?loginScheme naming the scheme its token fills (declared: ${known}).`
		};
	}

	let host = '';
	try {
		host = new URL(baseUrl).host.toLowerCase();
	} catch {
		// an unparseable base URL has no host to trust
	}
	if (!credentialHosts.has(host)) {
		return { error: `Refusing to send a password to ${host || baseUrl}, a host not declared.` };
	}

	return { tool, recipe, scheme, credentials };
}

async function cacheKey(baseUrl: string, recipe: LoginRecipe, creds: LoginCredentials) {
	const input = JSON.stringify([baseUrl, recipe.operationId, creds.username, creds.password]);
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function dig(value: unknown, path: string): unknown {
	let current = value;
	for (const part of path.split('.')) {
		if (!current || typeof current !== 'object') return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

/**
 * Returns a token for the login, reusing a cached one unless `fresh` is set.
 * `cached` tells the caller whether a 401 is worth one retry with a fresh login.
 */
export async function loginToken(
	setup: Exclude<LoginSetup, { error: string }>,
	baseUrl: string,
	options: CallOptions,
	fresh = false
): Promise<{ token: string; cached: boolean } | { error: string }> {
	const { tool, recipe, credentials } = setup;
	const key = await cacheKey(baseUrl, recipe, credentials);

	if (!fresh) {
		const hit = tokens.get(key);
		if (hit) return { token: hit, cached: true };
	}
	tokens.delete(key);

	const bodyArg =
		Object.entries(tool.bindings).find(([, binding]) => binding.in === 'body')?.[0] ?? 'body';
	const outcome = await executeCall(
		tool,
		{ [bodyArg]: { username: credentials.username, password: credentials.password } },
		baseUrl,
		{ headers: {}, query: {}, cookies: {}, missing: [] },
		options
	);

	const text = outcome.result.content
		.map((block) => (block.type === 'text' ? block.text : ''))
		.join('');
	if (outcome.result.isError) {
		return { error: `Login through ${recipe.operationId} failed: ${text}` };
	}

	let token: unknown;
	try {
		token = dig(JSON.parse(text), recipe.token);
	} catch {
		token = undefined;
	}
	if (typeof token !== 'string' || !token) {
		return { error: `Login through ${recipe.operationId} returned no token at "${recipe.token}".` };
	}

	if (tokens.size >= MAX_CACHED_TOKENS) tokens.delete(tokens.keys().next().value!);
	tokens.set(key, token);
	return { token, cached: false };
}

/** a copy of the supplied credentials with the token placed where its scheme expects it */
export function withToken(
	supplied: SuppliedCredentials,
	schemeName: string,
	scheme: SecurityScheme,
	token: string
): SuppliedCredentials {
	const out: SuppliedCredentials = {
		...supplied,
		headers: new Map(supplied.headers),
		query: new Map(supplied.query),
		cookies: new Map(supplied.cookies),
		schemes: new Map(supplied.schemes)
	};
	out.schemes.set(schemeName, token);

	// also placed by location so operations that declare no security still carry it
	if (scheme.type === 'apiKey' && scheme.name) {
		const target =
			scheme.in === 'query' ? out.query : scheme.in === 'cookie' ? out.cookies : out.headers;
		target.set(scheme.name, token);
	} else if (scheme.type === 'http' && scheme.scheme && scheme.scheme.toLowerCase() !== 'bearer') {
		out.authorization = `${scheme.scheme} ${token}`;
	} else {
		out.authorization = `Bearer ${token}`;
	}
	return out;
}

/** exposed so tests can start from a known state */
export function clearLoginTokens(): void {
	tokens.clear();
}
