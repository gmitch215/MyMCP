import { parse as parseYaml } from 'yaml';
import { extractSpecUrls, looksLikeHtml, serviceDescLinks, wellKnownCandidates } from './discover';
import type { Env } from './env';
import { allowedHosts, allowlistOnly, exemptHosts, fetchTimeoutMs, maxSpecBytes } from './env';
import { NetworkPolicyError, assertSafeUrl, readCapped, safeFetch } from './net';
import { convertSwagger2 } from './openapi/swagger2';
import { resolveServerUrl } from './openapi/params';
import type { ToolFilter } from './openapi/tools';
import { buildToolTable } from './openapi/tools';
import type { OpenAPI, ToolTable } from './types';
import { isSwagger2, isValidOpenAPI } from './types';
import servers from './servers.json';

const ALIASES = servers as Record<string, string>;

export class ResolveError extends Error {
	readonly status: number;
	readonly reason: string;

	constructor(status: number, reason: string, message: string) {
		super(message);
		this.name = 'ResolveError';
		this.status = status;
		this.reason = reason;
	}
}

export function knownAliases(): string[] {
	return Object.keys(ALIASES).sort();
}

/**
 * Turns the `{server}` path segment into a description URL.
 * Accepts an alias, a full https URL, or a bare hostname, which gains the https scheme.
 */
export function resolveServerToken(token: string, env: Env): string {
	const trimmed = token.trim();
	if (!trimmed) throw new ResolveError(400, 'empty_server', 'No server was specified');

	const alias = ALIASES[trimmed];
	if (alias) return alias;

	if (allowlistOnly(env)) {
		throw new ResolveError(
			403,
			'not_allowlisted',
			`This deployment only serves preconfigured servers. Known: ${knownAliases().join(', ')}`
		);
	}

	if (/^http:\/\//i.test(trimmed)) {
		if (exemptHosts(env).size > 0) return trimmed;
		throw new ResolveError(400, 'insecure_scheme', 'Descriptions must be served over https');
	}

	if (/^https:\/\//i.test(trimmed)) return trimmed;

	// a bare hostname or host/path is the friendlier form; assume https rather than rejecting
	if (/^[a-z0-9-]+(\.[a-z0-9-]+)+([/:?#].*)?$/i.test(trimmed)) return `https://${trimmed}`;

	throw new ResolveError(
		404,
		'unknown_server',
		`Unknown server "${trimmed}". Pass a full https URL to an OpenAPI description, or use one of: ${knownAliases().join(', ')}`
	);
}

export interface LoadedSpec {
	doc: OpenAPI;
	/** the URL the description was actually read from, after any discovery */
	sourceUrl: string;
	etag?: string;
}

function parseSpec(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) return undefined;

	if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return undefined;
		}
	}

	try {
		return parseYaml(trimmed, { maxAliasCount: 1000 });
	} catch {
		return undefined;
	}
}

/** normalises whatever parsed out of the body into an OpenAPI 3 document, or undefined */
export function normalizeSpec(parsed: unknown): OpenAPI | undefined {
	if (!parsed || typeof parsed !== 'object') return undefined;

	const doc = isSwagger2(parsed) ? convertSwagger2(parsed) : (parsed as OpenAPI);
	return isValidOpenAPI(doc) ? doc : undefined;
}

async function fetchText(url: string, env: Env): Promise<{ text: string; response: Response }> {
	const response = await safeFetch(
		url,
		{
			headers: {
				Accept: 'application/json, application/yaml, text/yaml, text/html;q=0.8, */*;q=0.5'
			}
		},
		{ timeoutMs: fetchTimeoutMs(env), exemptHosts: exemptHosts(env) }
	);

	if (!response.ok) {
		throw new ResolveError(
			502,
			'fetch_failed',
			`Could not fetch ${url}: ${response.status} ${response.statusText}`
		);
	}

	const bytes = await readCapped(response, maxSpecBytes(env));
	return { text: new TextDecoder().decode(bytes), response };
}

/**
 * Loads an OpenAPI description, following documentation pages when the URL does not serve one
 * directly. Scalar, Swagger UI, Redoc, Stoplight and RapiDoc pages all embed the real location.
 */
export async function loadSpec(url: string, env: Env): Promise<LoadedSpec> {
	const exempt = exemptHosts(env);
	assertSafeUrl(url, exempt);

	const { text, response } = await fetchText(url, env);

	const direct = normalizeSpec(parseSpec(text));
	if (direct) {
		return { doc: direct, sourceUrl: url, etag: response.headers.get('etag') ?? undefined };
	}

	const candidates = [
		...serviceDescLinks(response.headers, url),
		...(looksLikeHtml(response.headers.get('content-type'), text)
			? extractSpecUrls(text, url)
			: []),
		...wellKnownCandidates(url)
	];

	const tried = new Set<string>([url]);
	for (const candidate of candidates) {
		if (tried.has(candidate)) continue;
		tried.add(candidate);

		try {
			assertSafeUrl(candidate, exempt);
			const attempt = await fetchText(candidate, env);
			const doc = normalizeSpec(parseSpec(attempt.text));
			if (doc) {
				return {
					doc,
					sourceUrl: candidate,
					etag: attempt.response.headers.get('etag') ?? undefined
				};
			}
		} catch {
			// a candidate that does not resolve is expected; keep going
		}

		if (tried.size > 16) break;
	}

	throw new ResolveError(
		422,
		'not_openapi',
		`No OpenAPI description found at ${url}. Point directly at the description, or link it with rel="service-desc".`
	);
}

interface CacheEntry {
	table: ToolTable;
	sourceUrl: string;
	expires: number;
}

const TABLE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHED_TABLES = 24;

const tableCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CacheEntry>>();

function cacheKey(specUrl: string, filter: ToolFilter): string {
	return JSON.stringify([
		specUrl,
		filter.tags ?? null,
		filter.methods ?? null,
		filter.include ?? null,
		filter.exclude ?? null,
		filter.max ?? null,
		filter.outputSchema ?? null
	]);
}

function evictIfNeeded(): void {
	if (tableCache.size <= MAX_CACHED_TABLES) return;
	const oldest = tableCache.keys().next();
	if (!oldest.done) tableCache.delete(oldest.value);
}

/**
 * Builds (or reuses) the tool table for a description.
 *
 * Concurrent misses for the same key share one build, so a cold isolate does not parse a large
 * description several times over.
 */
export async function getToolTable(
	specUrl: string,
	filter: ToolFilter,
	env: Env
): Promise<{ table: ToolTable; sourceUrl: string }> {
	const key = cacheKey(specUrl, filter);
	const now = Date.now();

	const cached = tableCache.get(key);
	if (cached && cached.expires > now) return { table: cached.table, sourceUrl: cached.sourceUrl };

	const pending = inFlight.get(key);
	if (pending) {
		const entry = await pending;
		return { table: entry.table, sourceUrl: entry.sourceUrl };
	}

	const build = (async (): Promise<CacheEntry> => {
		const loaded = await loadSpec(specUrl, env);
		const table = buildToolTable(loaded.doc, filter);
		const entry: CacheEntry = {
			table,
			sourceUrl: loaded.sourceUrl,
			expires: Date.now() + TABLE_TTL_MS
		};
		tableCache.set(key, entry);
		evictIfNeeded();
		return entry;
	})();

	inFlight.set(key, build);
	try {
		const entry = await build;
		return { table: entry.table, sourceUrl: entry.sourceUrl };
	} finally {
		inFlight.delete(key);
	}
}

/** exposed so tests can start from a known state */
export function clearToolTableCache(): void {
	tableCache.clear();
	inFlight.clear();
}

/**
 * The base URL API calls are made against.
 * A relative `servers[]` entry, or none at all, resolves against the description's own origin.
 */
export function resolveBaseUrl(
	table: ToolTable,
	sourceUrl: string,
	serverIndex = 0,
	variables: Record<string, string> = {}
): string {
	const origin = new URL(sourceUrl).origin;
	const server = table.servers[serverIndex] ?? table.servers[0];
	if (!server?.url) return origin;

	const resolved = resolveServerUrl(server, variables);
	if (/^https?:\/\//i.test(resolved)) return resolved;

	try {
		return new URL(resolved, origin).toString().replace(/\/$/, '');
	} catch {
		return origin;
	}
}

/**
 * Hosts allowed to receive caller-supplied credentials: those the description declares, plus any
 * configured for the deployment. A description fetched from an arbitrary URL therefore cannot
 * redirect a credential to a host of its own choosing.
 */
export function credentialHosts(table: ToolTable, sourceUrl: string, env: Env): Set<string> {
	const hosts = allowedHosts(env);

	try {
		hosts.add(new URL(sourceUrl).host.toLowerCase());
	} catch {
		// a source URL that will not parse cannot contribute a host
	}

	const origin = (() => {
		try {
			return new URL(sourceUrl).origin;
		} catch {
			return undefined;
		}
	})();

	for (const server of table.servers) {
		if (!server?.url) continue;
		const resolved = resolveServerUrl(server);
		try {
			const url = /^https?:\/\//i.test(resolved)
				? new URL(resolved)
				: origin
					? new URL(resolved, origin)
					: undefined;
			if (url) hosts.add(url.host.toLowerCase());
		} catch {
			// a server entry that will not parse contributes nothing
		}
	}

	return hosts;
}

export { NetworkPolicyError };
