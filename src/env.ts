export interface Env {
	ASSETS?: Fetcher;

	/** durable storage for tasks, upstream tokens and derived tool tables; all optional */
	MYMCP_KV?: KVNamespace;

	/** key for sealing MRTR request state and SSE channel ids */
	STATE_SECRET?: string;

	/** identity provider for MCP authorization: selfhosted | access | oidc */
	AUTH_PROVIDER?: string;
	AUTH_ISSUER?: string;
	AUTH_JWKS_URL?: string;
	AUTH_AUDIENCE?: string;
	AUTH_SCOPES?: string;
	ACCESS_TEAM_DOMAIN?: string;
	ACCESS_AUD?: string;
	/** operator password for the self-hosted authorization server */
	SELFHOST_PASSWORD?: string;

	/** bridges the deprecated 2024-11-05 HTTP+SSE transport; optional */
	MCP_SSE?: DurableObjectNamespace;

	/** set to "0" to stop requiring the Mcp-Method and Mcp-Name headers */
	MCP_STRICT_HEADERS?: string;

	/** comma-separated hosts always permitted, in addition to those a description declares */
	ALLOWED_HOSTS?: string;
	/** when "1", only aliases in servers.json and ALLOWED_HOSTS resolve */
	ALLOWLIST_ONLY?: string;
	/**
	 * comma-separated `host:port` entries exempted from the network policy, allowing plain http
	 * and private addresses. Empty by default; only for an instance deployed alongside a private
	 * API, since every entry is a host a caller can then reach through this service.
	 */
	INSECURE_UPSTREAM_HOSTS?: string;

	MAX_SPEC_BYTES?: string;
	MAX_RESPONSE_BYTES?: string;
	FETCH_TIMEOUT_MS?: string;
}

function num(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function maxSpecBytes(env: Env): number {
	return num(env.MAX_SPEC_BYTES, 12 * 1024 * 1024);
}

export function maxResponseBytes(env: Env): number {
	return num(env.MAX_RESPONSE_BYTES, 2 * 1024 * 1024);
}

export function fetchTimeoutMs(env: Env): number {
	return num(env.FETCH_TIMEOUT_MS, 20_000);
}

export function allowlistOnly(env: Env): boolean {
	return env.ALLOWLIST_ONLY === '1' || env.ALLOWLIST_ONLY === 'true';
}

export function allowedHosts(env: Env): Set<string> {
	const raw = env.ALLOWED_HOSTS ?? '';
	return new Set(
		raw
			.split(',')
			.map((h) => h.trim().toLowerCase())
			.filter(Boolean)
	);
}

export function exemptHosts(env: Env): Set<string> {
	const raw = env.INSECURE_UPSTREAM_HOSTS ?? '';
	return new Set(
		raw
			.split(',')
			.map((h) => h.trim().toLowerCase())
			.filter(Boolean)
	);
}

export function authEnabled(env: Env): boolean {
	return !!env.AUTH_PROVIDER && env.AUTH_PROVIDER !== 'none';
}
