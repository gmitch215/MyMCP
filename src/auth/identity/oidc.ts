import type { Env } from '../../env';
import { scopesOf, verifyJwt } from '../jwt';
import type { IdentityProvider, Principal } from './index';
import { DEFAULT_SCOPES, parseScopes } from './index';

interface ProviderMetadata {
	issuer?: string;
	jwks_uri?: string;
	scopes_supported?: string[];
}

const METADATA_TTL_MS = 30 * 60 * 1000;
const metadataCache = new Map<string, { value: ProviderMetadata; expires: number }>();

/** tries OIDC Discovery, then RFC 8414 authorization server metadata */
async function discover(issuer: string): Promise<ProviderMetadata | undefined> {
	const cached = metadataCache.get(issuer);
	if (cached && cached.expires > Date.now()) return cached.value;

	const base = issuer.replace(/\/$/, '');
	const candidates = [
		`${base}/.well-known/openid-configuration`,
		`${base}/.well-known/oauth-authorization-server`
	];

	for (const url of candidates) {
		try {
			const response = await fetch(url, { headers: { Accept: 'application/json' } });
			if (!response.ok) continue;

			const value = (await response.json()) as ProviderMetadata;
			if (!value.jwks_uri) continue;

			metadataCache.set(issuer, { value, expires: Date.now() + METADATA_TTL_MS });
			return value;
		} catch {
			// try the next well-known location
		}
	}
	return undefined;
}

export function clearMetadataCache(): void {
	metadataCache.clear();
}

/** Any third-party OpenID Connect or OAuth 2.1 authorization server. */
export function createOidcProvider(env: Env): IdentityProvider | undefined {
	const issuer = env.AUTH_ISSUER;
	if (!issuer) return undefined;

	const scopes = parseScopes(env.AUTH_SCOPES, DEFAULT_SCOPES);

	return {
		name: 'oidc',

		authorizationServers() {
			return [issuer];
		},

		scopesSupported() {
			return scopes;
		},

		async verify(token: string, resource: string): Promise<Principal | null> {
			const jwksUrl = env.AUTH_JWKS_URL ?? (await discover(issuer))?.jwks_uri;
			if (!jwksUrl) return null;

			const claims = await verifyJwt(token, {
				jwksUrl,
				issuer,
				audience: env.AUTH_AUDIENCE ?? resource,
				requireAudience: true
			});
			if (!claims || typeof claims.sub !== 'string' || !claims.sub) return null;

			return { sub: claims.sub, scopes: scopesOf(claims), claims };
		}
	};
}
