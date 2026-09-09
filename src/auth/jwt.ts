import { fromBase64Url } from '../state';

export interface JwtClaims {
	iss?: string;
	sub?: string;
	aud?: string | string[];
	exp?: number;
	nbf?: number;
	iat?: number;
	scope?: string;
	scp?: string | string[];
	[claim: string]: unknown;
}

interface Jwk {
	kty: string;
	kid?: string;
	alg?: string;
	use?: string;
	n?: string;
	e?: string;
	crv?: string;
	x?: string;
	y?: string;
}

const ALGORITHMS: Record<string, { name: string; hash: string; namedCurve?: string }> = {
	RS256: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
	RS384: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
	RS512: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' },
	PS256: { name: 'RSA-PSS', hash: 'SHA-256' },
	ES256: { name: 'ECDSA', hash: 'SHA-256', namedCurve: 'P-256' },
	ES384: { name: 'ECDSA', hash: 'SHA-384', namedCurve: 'P-384' }
};

const JWKS_TTL_MS = 10 * 60 * 1000;
const jwksCache = new Map<string, { keys: Jwk[]; expires: number }>();

export async function fetchJwks(url: string): Promise<Jwk[]> {
	const cached = jwksCache.get(url);
	if (cached && cached.expires > Date.now()) return cached.keys;

	const response = await fetch(url, { headers: { Accept: 'application/json' } });
	if (!response.ok) throw new Error(`Could not fetch JWKS: ${response.status}`);

	const body = (await response.json()) as { keys?: Jwk[] };
	const keys = Array.isArray(body.keys) ? body.keys : [];

	jwksCache.set(url, { keys, expires: Date.now() + JWKS_TTL_MS });
	return keys;
}

export function clearJwksCache(): void {
	jwksCache.clear();
}

function decodeSegment(segment: string): Record<string, unknown> {
	return JSON.parse(new TextDecoder().decode(fromBase64Url(segment))) as Record<string, unknown>;
}

async function importKey(jwk: Jwk, alg: string): Promise<CryptoKey> {
	const spec = ALGORITHMS[alg];
	if (!spec) throw new Error(`Unsupported JWT algorithm: ${alg}`);

	const algorithm =
		spec.name === 'ECDSA'
			? { name: 'ECDSA', namedCurve: spec.namedCurve! }
			: { name: spec.name, hash: spec.hash };

	return crypto.subtle.importKey('jwk', jwk as JsonWebKey, algorithm, false, ['verify']);
}

export interface VerifyOptions {
	jwksUrl: string;
	issuer?: string;
	audience?: string;
	/** accept a token whose audience is absent, for providers that omit it */
	requireAudience?: boolean;
	clockSkewSec?: number;
}

/** Verifies a JWS-signed JWT against a JWKS endpoint and the expected issuer and audience. */
export async function verifyJwt(token: string, options: VerifyOptions): Promise<JwtClaims | null> {
	const parts = token.split('.');
	if (parts.length !== 3) return null;

	const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

	let header: Record<string, unknown>;
	let claims: JwtClaims;
	try {
		header = decodeSegment(headerB64);
		claims = decodeSegment(payloadB64) as JwtClaims;
	} catch {
		return null;
	}

	const alg = typeof header.alg === 'string' ? header.alg : '';
	if (!ALGORITHMS[alg]) return null;

	const keys = await fetchJwks(options.jwksUrl);
	const kid = typeof header.kid === 'string' ? header.kid : undefined;
	const candidates = kid ? keys.filter((k) => k.kid === kid) : keys;
	if (candidates.length === 0) return null;

	const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
	const signature = fromBase64Url(signatureB64);
	const spec = ALGORITHMS[alg]!;

	let verified = false;
	for (const jwk of candidates) {
		try {
			const key = await importKey(jwk, alg);
			const params =
				spec.name === 'ECDSA'
					? { name: 'ECDSA', hash: spec.hash }
					: spec.name === 'RSA-PSS'
						? { name: 'RSA-PSS', saltLength: 32 }
						: { name: spec.name };

			if (
				await crypto.subtle.verify(
					params,
					key,
					signature as unknown as BufferSource,
					data as unknown as BufferSource
				)
			) {
				verified = true;
				break;
			}
		} catch {
			// a key that will not import is simply not the right key
		}
	}
	if (!verified) return null;

	const skew = options.clockSkewSec ?? 60;
	const now = Math.floor(Date.now() / 1000);

	if (typeof claims.exp === 'number' && claims.exp + skew < now) return null;
	if (typeof claims.nbf === 'number' && claims.nbf - skew > now) return null;
	if (options.issuer && claims.iss !== options.issuer) return null;

	if (options.audience) {
		const audience = claims.aud;
		const list = Array.isArray(audience) ? audience : audience ? [audience] : [];

		if (list.length === 0) {
			if (options.requireAudience !== false) return null;
		} else if (!list.includes(options.audience)) {
			return null;
		}
	}

	return claims;
}

export function scopesOf(claims: JwtClaims): string[] {
	if (typeof claims.scope === 'string') return claims.scope.split(/\s+/).filter(Boolean);
	if (Array.isArray(claims.scp))
		return claims.scp.filter((s): s is string => typeof s === 'string');
	if (typeof claims.scp === 'string') return claims.scp.split(/\s+/).filter(Boolean);
	return [];
}
