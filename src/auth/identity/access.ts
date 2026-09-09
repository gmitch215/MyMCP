import type { Env } from '../../env';
import { scopesOf, verifyJwt } from '../jwt';
import type { IdentityProvider, Principal } from './index';
import { DEFAULT_SCOPES, parseScopes } from './index';

/**
 * Cloudflare Access as the identity provider.
 *
 * Access puts a signed JWT on `Cf-Access-Jwt-Assertion` for browser traffic and issues service
 * tokens for machines; either way the team's JWKS is the verification root.
 */
export function createAccessProvider(env: Env): IdentityProvider | undefined {
	const team = env.ACCESS_TEAM_DOMAIN;
	if (!team) return undefined;

	const teamDomain = team.includes('://') ? team : `https://${team}`;
	const issuer = env.AUTH_ISSUER ?? teamDomain;
	const jwksUrl = env.AUTH_JWKS_URL ?? `${teamDomain}/cdn-cgi/access/certs`;
	const scopes = parseScopes(env.AUTH_SCOPES, DEFAULT_SCOPES);

	return {
		name: 'access',

		authorizationServers() {
			return [issuer];
		},

		scopesSupported() {
			return scopes;
		},

		async verify(token: string, resource: string): Promise<Principal | null> {
			const claims = await verifyJwt(token, {
				jwksUrl,
				issuer,
				// Access binds tokens to an application audience tag, not to the MCP resource URI
				audience: env.ACCESS_AUD ?? env.AUTH_AUDIENCE ?? resource,
				requireAudience: !!(env.ACCESS_AUD ?? env.AUTH_AUDIENCE)
			});
			if (!claims) return null;

			const sub =
				typeof claims.sub === 'string' && claims.sub
					? claims.sub
					: typeof claims.email === 'string'
						? claims.email
						: undefined;
			if (!sub) return null;

			return { sub, scopes: scopesOf(claims).length ? scopesOf(claims) : scopes, claims };
		}
	};
}
