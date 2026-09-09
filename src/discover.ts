/** paths commonly used to serve an OpenAPI description, tried when nothing else is found */
export const WELL_KNOWN_PATHS = [
	'/openapi.json',
	'/openapi.yaml',
	'/openapi',
	'/swagger.json',
	'/swagger.yaml',
	'/v3/api-docs',
	'/api-docs',
	'/api/openapi.json',
	'/docs/json',
	'/.well-known/openapi',
	'/swagger/v1/swagger.json'
] as const;

const ASSET_EXTENSIONS = /\.(js|mjs|cjs|css|png|jpe?g|gif|svg|ico|woff2?|ttf|map)(\?|#|$)/i;

const KNOWN_CDN_HOSTS = [
	'cdn.jsdelivr.net',
	'unpkg.com',
	'cdnjs.cloudflare.com',
	'fonts.googleapis.com',
	'fonts.gstatic.com',
	'code.jquery.com'
];

/**
 * Patterns used by the common API documentation renderers to point at their description.
 * Ordered by specificity: an explicit attribute beats a bare `url` key in a config blob.
 */
const PATTERNS: RegExp[] = [
	// RFC 8631 service description link
	/<link\b[^>]*\brel=["']?service-desc["']?[^>]*\bhref=["']([^"']+)["']/gi,
	/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']?service-desc["']?/gi,
	// Redoc
	/<redoc\b[^>]*\bspec-url=["']([^"']+)["']/gi,
	/Redoc\.init\s*\(\s*["']([^"']+)["']/gi,
	// RapiDoc
	/<rapi-doc\b[^>]*\bspec-url=["']([^"']+)["']/gi,
	// Stoplight Elements
	/<elements-api\b[^>]*\bapiDescriptionUrl=["']([^"']+)["']/gi,
	// Scalar
	/<script\b[^>]*\bid=["']api-reference["'][^>]*\bdata-url=["']([^"']+)["']/gi,
	/\bdata-url=["']([^"']+)["']/gi,
	// Swagger UI and Scalar configuration objects
	/\burls?\s*:\s*\[\s*\{\s*[^}]*?\burl\s*:\s*["']([^"']+)["']/gi,
	/["']?\burl["']?\s*:\s*["']([^"']+)["']/gi,
	/\bspecUrl\s*:\s*["']([^"']+)["']/gi,
	/\bapiDescriptionUrl\s*:\s*["']([^"']+)["']/gi
];

function looksLikeAsset(candidate: string): boolean {
	if (ASSET_EXTENSIONS.test(candidate)) return true;
	return KNOWN_CDN_HOSTS.some((host) => candidate.includes(host));
}

/**
 * Extracts candidate OpenAPI description URLs from a documentation page.
 *
 * Purely textual: the page's scripts are never executed. Returns absolute URLs in priority
 * order, deduplicated, for the caller to try in turn.
 */
export function extractSpecUrls(html: string, baseUrl: string | URL): string[] {
	const found: string[] = [];
	const seen = new Set<string>();

	for (const pattern of PATTERNS) {
		pattern.lastIndex = 0;
		let match: RegExpExecArray | null;

		while ((match = pattern.exec(html)) !== null) {
			const raw = match[1];
			if (!raw || looksLikeAsset(raw)) continue;

			let absolute: string;
			try {
				absolute = new URL(raw, baseUrl).toString();
			} catch {
				continue;
			}

			if (seen.has(absolute)) continue;
			seen.add(absolute);
			found.push(absolute);
		}
	}

	return found;
}

/** Reads `Link: <...>; rel="service-desc"` headers, the standards-defined discovery route. */
export function serviceDescLinks(headers: Headers, baseUrl: string | URL): string[] {
	const header = headers.get('link');
	if (!header) return [];

	const out: string[] = [];
	for (const part of header.split(',')) {
		const match = part.match(/<([^>]+)>\s*;(.*)$/);
		if (!match?.[1] || !match[2]) continue;
		if (!/rel\s*=\s*"?service-desc"?/i.test(match[2])) continue;

		try {
			out.push(new URL(match[1].trim(), baseUrl).toString());
		} catch {
			// a malformed Link value is not worth failing discovery over
		}
	}
	return out;
}

/** Absolute URLs for the well-known description paths relative to a page's origin. */
export function wellKnownCandidates(baseUrl: string | URL): string[] {
	const out: string[] = [];
	for (const path of WELL_KNOWN_PATHS) {
		try {
			out.push(new URL(path, baseUrl).toString());
		} catch {
			// ignore
		}
	}
	return out;
}

export function looksLikeHtml(contentType: string | null, body: string): boolean {
	if (contentType && contentType.toLowerCase().includes('html')) return true;
	return /^\s*(<!doctype html|<html\b)/i.test(body);
}
