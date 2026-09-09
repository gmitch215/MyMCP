import type { SecurityRequirement, SecurityScheme } from '../types';

const PREFIX = 'x-mcp-upstream-';
const QUERY_PREFIX = `${PREFIX}query-`;
const COOKIE_PREFIX = `${PREFIX}cookie-`;
const SCHEME_PREFIX = `${PREFIX}scheme-`;

/** credentials the caller supplied for the upstream API, keyed by where they belong */
export interface SuppliedCredentials {
	authorization?: string;
	headers: Map<string, string>;
	query: Map<string, string>;
	cookies: Map<string, string>;
	schemes: Map<string, string>;
}

/** credentials resolved against the spec's security schemes, ready to apply to a request */
export interface AppliedCredentials {
	headers: Record<string, string>;
	query: Record<string, string>;
	cookies: Record<string, string>;
	/** security scheme names that were declared but had no credential supplied */
	missing: string[];
}

/** Headers.forEach lowercases names, so restore the conventional hyphen-capitalised form */
function canonicalHeaderName(name: string): string {
	return name
		.split('-')
		.map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
		.join('-');
}

export function emptyCredentials(): SuppliedCredentials {
	return {
		headers: new Map(),
		query: new Map(),
		cookies: new Map(),
		schemes: new Map()
	};
}

/**
 * Reads upstream credentials from the MCP request.
 *
 * Only the `X-Mcp-Upstream-*` family is read. The `Authorization` header is deliberately NOT
 * consulted: that header belongs to MCP's own authorization, and forwarding it upstream would be
 * the token passthrough the MCP security guidance forbids.
 */
export function readSuppliedCredentials(headers: Headers): SuppliedCredentials {
	const supplied = emptyCredentials();

	headers.forEach((value, rawName) => {
		const name = rawName.toLowerCase();
		if (!name.startsWith(PREFIX) || !value) return;

		if (name.startsWith(QUERY_PREFIX)) {
			const key = rawName.slice(QUERY_PREFIX.length);
			if (key) supplied.query.set(key, value);
			return;
		}
		if (name.startsWith(COOKIE_PREFIX)) {
			const key = rawName.slice(COOKIE_PREFIX.length);
			if (key) supplied.cookies.set(key, value);
			return;
		}
		if (name.startsWith(SCHEME_PREFIX)) {
			const key = rawName.slice(SCHEME_PREFIX.length);
			if (key) supplied.schemes.set(key, value);
			return;
		}

		const headerName = rawName.slice(PREFIX.length);
		if (!headerName) return;

		if (headerName.toLowerCase() === 'authorization') {
			supplied.authorization = value;
			return;
		}
		supplied.headers.set(canonicalHeaderName(headerName), value);
	});

	return supplied;
}

function lookupCaseInsensitive(map: Map<string, string>, key: string): string | undefined {
	const direct = map.get(key);
	if (direct !== undefined) return direct;

	const lower = key.toLowerCase();
	for (const [k, v] of map) {
		if (k.toLowerCase() === lower) return v;
	}
	return undefined;
}

/** the security requirements in force for an operation, falling back to the document's */
export function effectiveSecurity(
	operationSecurity: SecurityRequirement[] | undefined,
	documentSecurity: SecurityRequirement[]
): SecurityRequirement[] {
	if (operationSecurity !== undefined) return operationSecurity;
	return documentSecurity;
}

/**
 * Maps supplied credentials onto the schemes an operation actually declares.
 *
 * Security requirements are alternatives: satisfying any one entry is enough, so `missing` is
 * only populated when no alternative could be satisfied.
 */
export function applySecurity(
	schemes: Record<string, SecurityScheme>,
	requirements: SecurityRequirement[],
	supplied: SuppliedCredentials,
	stored?: Map<string, string>
): AppliedCredentials {
	const applied: AppliedCredentials = { headers: {}, query: {}, cookies: {}, missing: [] };

	// unmatched X-Mcp-Upstream-<Header> values pass through as an escape hatch for
	// APIs that need headers their own description does not declare
	for (const [name, value] of supplied.headers) applied.headers[name] = value;

	if (requirements.length === 0) {
		if (supplied.authorization) applied.headers['Authorization'] = supplied.authorization;
		for (const [name, value] of supplied.query) applied.query[name] = value;
		for (const [name, value] of supplied.cookies) applied.cookies[name] = value;
		return applied;
	}

	const unsatisfied: string[] = [];

	for (const requirement of requirements) {
		const names = Object.keys(requirement);
		if (names.length === 0) return applied; // an empty entry means "no auth required"

		const staged: AppliedCredentials = { headers: {}, query: {}, cookies: {}, missing: [] };
		let satisfied = true;

		for (const schemeName of names) {
			const scheme = schemes[schemeName];
			if (!scheme) {
				satisfied = false;
				unsatisfied.push(schemeName);
				break;
			}

			// header names arrive lowercased, so scheme names are matched case-insensitively;
			// the credential is then emitted under the name the description declares
			const explicit =
				lookupCaseInsensitive(supplied.schemes, schemeName) ?? stored?.get(schemeName);
			if (!applyScheme(scheme, schemeName, explicit, supplied, staged)) {
				satisfied = false;
				unsatisfied.push(schemeName);
				break;
			}
		}

		if (satisfied) {
			Object.assign(applied.headers, staged.headers);
			Object.assign(applied.query, staged.query);
			Object.assign(applied.cookies, staged.cookies);
			return applied;
		}
	}

	applied.missing = [...new Set(unsatisfied)];

	// still forward what was supplied; the upstream is the authority on whether it suffices
	if (supplied.authorization) applied.headers['Authorization'] = supplied.authorization;
	for (const [name, value] of supplied.query) applied.query[name] = value;
	for (const [name, value] of supplied.cookies) applied.cookies[name] = value;

	return applied;
}

function applyScheme(
	scheme: SecurityScheme,
	schemeName: string,
	explicit: string | undefined,
	supplied: SuppliedCredentials,
	out: AppliedCredentials
): boolean {
	switch (scheme.type) {
		case 'http': {
			const kind = (scheme.scheme ?? 'bearer').toLowerCase();
			const value = explicit ?? supplied.authorization;
			if (!value) return false;

			if (kind === 'bearer') {
				out.headers['Authorization'] = /^bearer /i.test(value) ? value : `Bearer ${value}`;
				return true;
			}
			if (kind === 'basic') {
				out.headers['Authorization'] = /^basic /i.test(value) ? value : `Basic ${toBasic(value)}`;
				return true;
			}
			out.headers['Authorization'] = new RegExp(`^${kind} `, 'i').test(value)
				? value
				: `${scheme.scheme} ${value}`;
			return true;
		}

		case 'oauth2':
		case 'openIdConnect': {
			const value = explicit ?? supplied.authorization;
			if (!value) return false;
			out.headers['Authorization'] = /^bearer /i.test(value) ? value : `Bearer ${value}`;
			return true;
		}

		case 'apiKey': {
			const keyName = scheme.name;
			if (!keyName) return false;

			const location = scheme.in ?? 'header';
			const value =
				explicit ??
				(location === 'header'
					? lookupCaseInsensitive(supplied.headers, keyName)
					: location === 'query'
						? lookupCaseInsensitive(supplied.query, keyName)
						: lookupCaseInsensitive(supplied.cookies, keyName)) ??
				// a lone Authorization value is a reasonable stand-in for a single-key scheme
				(supplied.schemes.size === 0 && supplied.headers.size === 0
					? supplied.authorization
					: undefined);

			if (!value) return false;

			if (location === 'header') out.headers[keyName] = value;
			else if (location === 'query') out.query[keyName] = value;
			else out.cookies[keyName] = value;
			return true;
		}

		case 'mutualTLS':
			// nothing to carry in-band; the connection either presents a certificate or it does not
			return true;

		default:
			void schemeName;
			return false;
	}
}

function toBasic(value: string): string {
	if (!value.includes(':')) return value;
	const bytes = new TextEncoder().encode(value);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/** true when credentials may be sent to `target`, i.e. it is a host the description declares */
export function isTrustedUpstream(target: URL, declaredHosts: Set<string>): boolean {
	return declaredHosts.has(target.host.toLowerCase());
}
