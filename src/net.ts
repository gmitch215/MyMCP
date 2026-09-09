export class NetworkPolicyError extends Error {
	readonly reason: string;

	constructor(reason: string, message: string) {
		super(message);
		this.name = 'NetworkPolicyError';
		this.reason = reason;
	}
}

const BLOCKED_HOSTNAMES = new Set([
	'localhost',
	'localhost.localdomain',
	'metadata',
	'metadata.google.internal',
	'instance-data'
]);

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'];

function parseIPv4(host: string): number[] | null {
	const parts = host.split('.');
	if (parts.length !== 4) return null;

	const octets: number[] = [];
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const n = Number(part);
		if (n > 255) return null;
		octets.push(n);
	}
	return octets;
}

function isBlockedIPv4(octets: number[]): boolean {
	const [a = 0, b = 0] = octets;

	if (a === 0) return true; // "this network"
	if (a === 10) return true; // RFC1918
	if (a === 127) return true; // loopback
	if (a === 169 && b === 254) return true; // link-local, includes cloud metadata
	if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
	if (a === 192 && b === 168) return true; // RFC1918
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
	if (a === 192 && b === 0 && octets[2] === 0) return true; // IETF protocol assignments
	if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
	if (a >= 224) return true; // multicast and reserved
	return false;
}

/** expands an IPv6 address to its eight numeric hextets, or null if it will not parse */
function expandIPv6(addr: string): number[] | null {
	let text = addr;

	// a trailing dotted quad (v4-mapped form) becomes two hextets
	const dotted = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
	if (dotted?.[1]) {
		const octets = parseIPv4(dotted[1]);
		if (!octets) return null;
		const [a = 0, b = 0, c = 0, d = 0] = octets;
		text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}

	const halves = text.split('::');
	if (halves.length > 2) return null;

	const parseGroup = (group: string): number[] | null => {
		if (group === '') return [];
		const out: number[] = [];
		for (const part of group.split(':')) {
			if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
			out.push(parseInt(part, 16));
		}
		return out;
	};

	const head = parseGroup(halves[0] ?? '');
	if (!head) return null;

	if (halves.length === 1) return head.length === 8 ? head : null;

	const tail = parseGroup(halves[1] ?? '');
	if (!tail) return null;

	const fill = 8 - head.length - tail.length;
	if (fill < 0) return null;

	return [...head, ...new Array(fill).fill(0), ...tail];
}

function isBlockedIPv6(host: string): boolean {
	const addr = host.replace(/^\[|\]$/g, '').toLowerCase();

	const hextets = expandIPv6(addr);
	if (!hextets) return true; // an address we cannot reason about is not one we should reach

	const allZero = hextets.slice(0, 5).every((h) => h === 0);

	// v4-mapped (::ffff:a.b.c.d) and v4-compatible (::a.b.c.d) tunnel the v4 policy through v6
	if (allZero && (hextets[5] === 0xffff || hextets[5] === 0)) {
		const high = hextets[6] ?? 0;
		const low = hextets[7] ?? 0;
		const octets = [high >> 8, high & 0xff, low >> 8, low & 0xff];

		// ::1 is loopback and :: is unspecified; both are blocked outright
		if (hextets[5] === 0 && high === 0 && (low === 1 || low === 0)) return true;
		if (hextets[5] === 0xffff || high !== 0 || low !== 0) return isBlockedIPv4(octets);
		return true;
	}

	const first = hextets[0] ?? 0;
	if ((first & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
	if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
	return false;
}

/**
 * Rejects URLs that could be used to reach infrastructure rather than a public API.
 * Applied to the description URL, every discovery candidate, and each redirect hop.
 *
 * `exempt` holds `host:port` entries a deployment has explicitly opted in to, for the case of a
 * self-hosted instance sitting alongside a private API. It is empty unless configured.
 */
export function assertSafeUrl(input: string | URL, exempt?: Set<string>): URL {
	let url: URL;
	try {
		url = typeof input === 'string' ? new URL(input) : input;
	} catch {
		throw new NetworkPolicyError('invalid_url', `Not a valid URL: ${String(input)}`);
	}

	if (exempt?.size && exempt.has(url.host.toLowerCase())) return url;

	if (url.protocol !== 'https:') {
		throw new NetworkPolicyError('insecure_scheme', `Only https is allowed, got ${url.protocol}`);
	}

	const host = url.hostname.toLowerCase();
	if (!host) throw new NetworkPolicyError('invalid_url', 'URL has no host');

	if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
		throw new NetworkPolicyError('blocked_host', `Host is not publicly routable: ${host}`);
	}

	if (host.startsWith('[') || host.includes(':')) {
		if (isBlockedIPv6(host)) {
			throw new NetworkPolicyError('blocked_host', `Address is not publicly routable: ${host}`);
		}
		return url;
	}

	const octets = parseIPv4(host);
	if (octets && isBlockedIPv4(octets)) {
		throw new NetworkPolicyError('blocked_host', `Address is not publicly routable: ${host}`);
	}

	return url;
}

export interface SafeFetchOptions {
	timeoutMs?: number;
	maxRedirects?: number;
	/** hosts that may receive the request's credential headers */
	credentialHosts?: Set<string>;
	/** `host:port` entries the deployment has opted out of the network policy for */
	exemptHosts?: Set<string>;
	signal?: AbortSignal;
}

const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

/**
 * Fetches with an SSRF check on every hop.
 *
 * Redirects are followed manually so each destination can be re-checked, and credential headers
 * are dropped the moment a redirect leaves the set of hosts allowed to receive them.
 */
export async function safeFetch(
	input: string | URL,
	init: RequestInit = {},
	options: SafeFetchOptions = {}
): Promise<Response> {
	const timeoutMs = options.timeoutMs ?? 15_000;
	const maxRedirects = options.maxRedirects ?? 5;

	let url = assertSafeUrl(input, options.exemptHosts);
	let headers = new Headers(init.headers);
	let body = init.body;
	let method = init.method ?? 'GET';

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	if (options.signal) {
		options.signal.addEventListener('abort', () => controller.abort(), { once: true });
	}

	try {
		for (let hop = 0; hop <= maxRedirects; hop++) {
			if (options.credentialHosts && !options.credentialHosts.has(url.host.toLowerCase())) {
				for (const name of CREDENTIAL_HEADERS) headers.delete(name);
			}

			const response = await fetch(url.toString(), {
				...init,
				method,
				headers,
				body,
				redirect: 'manual',
				signal: controller.signal
			});

			if (![301, 302, 303, 307, 308].includes(response.status)) return response;

			const location = response.headers.get('location');
			if (!location) return response;

			const next = assertSafeUrl(new URL(location, url), options.exemptHosts);

			// 303, and 301/302 on POST, degrade to GET per the HTTP semantics browsers implement
			if (
				response.status === 303 ||
				((response.status === 301 || response.status === 302) && method === 'POST')
			) {
				method = 'GET';
				body = undefined;
				headers = new Headers(headers);
				headers.delete('content-type');
				headers.delete('content-length');
			}

			if (next.origin !== url.origin) {
				headers = new Headers(headers);
				for (const name of CREDENTIAL_HEADERS) headers.delete(name);
			}

			url = next;
		}

		throw new NetworkPolicyError('too_many_redirects', `Exceeded ${maxRedirects} redirects`);
	} finally {
		clearTimeout(timer);
	}
}

export class ResponseTooLargeError extends Error {
	constructor(limit: number) {
		super(`Response exceeded ${limit} bytes`);
		this.name = 'ResponseTooLargeError';
	}
}

/** Reads a response body, refusing to buffer more than `limit` bytes. */
export async function readCapped(response: Response, limit: number): Promise<Uint8Array> {
	const declared = response.headers.get('content-length');
	if (declared && Number(declared) > limit) throw new ResponseTooLargeError(limit);

	if (!response.body) return new Uint8Array(0);

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;

			total += value.byteLength;
			if (total > limit) throw new ResponseTooLargeError(limit);
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

export async function readCappedText(response: Response, limit: number): Promise<string> {
	const bytes = await readCapped(response, limit);
	return new TextDecoder().decode(bytes);
}
