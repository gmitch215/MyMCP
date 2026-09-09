import type { Env } from '../../env';
import { createAccessProvider } from './access';
import { createOidcProvider } from './oidc';
import { createSelfHostedProvider } from './selfhosted';

export interface Principal {
	sub: string;
	scopes: string[];
	claims?: Record<string, unknown>;
}

export interface IdentityProvider {
	readonly name: string;
	/** authorization server issuers advertised in protected resource metadata */
	authorizationServers(): string[];
	/** scopes advertised as the minimum needed for basic functionality */
	scopesSupported(): string[];
	verify(token: string, resource: string): Promise<Principal | null>;
	/** endpoints this provider serves itself, if any */
	handle?(request: Request, url: URL, env: Env): Promise<Response | undefined>;
}

/**
 * Selects the identity provider for this deployment.
 * Returns undefined when no provider is configured, which leaves MCP authorization off.
 */
export function getIdentityProvider(env: Env): IdentityProvider | undefined {
	switch ((env.AUTH_PROVIDER ?? '').toLowerCase()) {
		case 'selfhosted':
		case 'self-hosted':
			return createSelfHostedProvider(env);
		case 'access':
		case 'cloudflare-access':
			return createAccessProvider(env);
		case 'oidc':
			return createOidcProvider(env);
		default:
			return undefined;
	}
}

export function parseScopes(value: string | undefined, fallback: string[]): string[] {
	if (!value) return fallback;
	const parsed = value.split(/[\s,]+/).filter(Boolean);
	return parsed.length ? parsed : fallback;
}

export const DEFAULT_SCOPES = ['mcp:tools', 'mcp:read'];
