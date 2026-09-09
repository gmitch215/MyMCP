import { describe, expect, it } from 'vitest';
import {
	applySecurity,
	effectiveSecurity,
	isTrustedUpstream,
	readSuppliedCredentials
} from '../../src/auth/upstream';
import type { SecurityScheme } from '../../src/types';

const schemes: Record<string, SecurityScheme> = {
	bearerAuth: { type: 'http', scheme: 'bearer' },
	basicAuth: { type: 'http', scheme: 'basic' },
	headerKey: { type: 'apiKey', name: 'X-Api-Key', in: 'header' },
	queryKey: { type: 'apiKey', name: 'api_key', in: 'query' },
	cookieKey: { type: 'apiKey', name: 'TabroomToken', in: 'cookie' },
	oauth: {
		type: 'oauth2',
		flows: { authorizationCode: { authorizationUrl: 'https://a.example/authorize', scopes: {} } }
	}
};

function headers(values: Record<string, string>): Headers {
	return new Headers(values);
}

describe('readSuppliedCredentials', () => {
	it('reads the upstream authorization header', () => {
		const supplied = readSuppliedCredentials(
			headers({ 'X-Mcp-Upstream-Authorization': 'Bearer token123' })
		);
		expect(supplied.authorization).toBe('Bearer token123');
	});

	it('never reads the MCP Authorization header, which belongs to MCP itself', () => {
		const supplied = readSuppliedCredentials(headers({ Authorization: 'Bearer mcp-token' }));
		expect(supplied.authorization).toBeUndefined();
		expect(supplied.headers.size).toBe(0);
	});

	it('reads named header, query and cookie credentials', () => {
		const supplied = readSuppliedCredentials(
			headers({
				'X-Mcp-Upstream-X-Api-Key': 'k1',
				'X-Mcp-Upstream-Query-api_key': 'k2',
				'X-Mcp-Upstream-Cookie-TabroomToken': 'k3',
				'X-Mcp-Upstream-Scheme-bearerAuth': 'k4'
			})
		);

		expect(supplied.headers.get('X-Api-Key')).toBe('k1');
		expect(supplied.query.get('api_key')).toBe('k2');
		// HTTP lowercases header names in transit, so these are matched case-insensitively later
		expect([...supplied.cookies.values()]).toContain('k3');
		expect([...supplied.schemes.values()]).toContain('k4');
	});

	it('matches a mixed-case cookie name despite the header arriving lowercased', () => {
		const supplied = readSuppliedCredentials(
			headers({ 'X-Mcp-Upstream-Cookie-TabroomToken': 'secret' })
		);
		const applied = applySecurity(schemes, [{ cookieKey: [] }], supplied);

		// emitted under the name the description declares, not the lowercased transport form
		expect(applied.cookies.TabroomToken).toBe('secret');
	});

	it('matches a mixed-case security scheme name', () => {
		const supplied = readSuppliedCredentials(
			headers({ 'X-Mcp-Upstream-Scheme-bearerAuth': 'scheme-token' })
		);
		expect(applySecurity(schemes, [{ bearerAuth: [] }], supplied).headers.Authorization).toBe(
			'Bearer scheme-token'
		);
	});

	it('ignores unrelated headers', () => {
		const supplied = readSuppliedCredentials(headers({ 'X-Request-Id': 'abc', Cookie: 'a=b' }));
		expect(supplied.headers.size).toBe(0);
		expect(supplied.cookies.size).toBe(0);
	});
});

describe('applySecurity', () => {
	it('applies a bearer scheme and adds the prefix when missing', () => {
		const supplied = readSuppliedCredentials(
			headers({ 'X-Mcp-Upstream-Authorization': 'raw-token' })
		);
		const applied = applySecurity(schemes, [{ bearerAuth: [] }], supplied);

		expect(applied.headers.Authorization).toBe('Bearer raw-token');
		expect(applied.missing).toEqual([]);
	});

	it('keeps an already-prefixed bearer value as-is', () => {
		const supplied = readSuppliedCredentials(
			headers({ 'X-Mcp-Upstream-Authorization': 'Bearer abc' })
		);
		expect(applySecurity(schemes, [{ bearerAuth: [] }], supplied).headers.Authorization).toBe(
			'Bearer abc'
		);
	});

	it('base64-encodes user:pass for a basic scheme', () => {
		const supplied = readSuppliedCredentials(
			headers({ 'X-Mcp-Upstream-Authorization': 'user:pass' })
		);
		const applied = applySecurity(schemes, [{ basicAuth: [] }], supplied);

		expect(applied.headers.Authorization).toBe(`Basic ${btoa('user:pass')}`);
	});

	it('applies an apiKey scheme in the header', () => {
		const supplied = readSuppliedCredentials(headers({ 'X-Mcp-Upstream-X-Api-Key': 'secret' }));
		expect(applySecurity(schemes, [{ headerKey: [] }], supplied).headers['X-Api-Key']).toBe(
			'secret'
		);
	});

	it('applies an apiKey scheme in the query string', () => {
		const supplied = readSuppliedCredentials(headers({ 'X-Mcp-Upstream-Query-api_key': 'secret' }));
		expect(applySecurity(schemes, [{ queryKey: [] }], supplied).query.api_key).toBe('secret');
	});

	it('applies an apiKey scheme in a cookie', () => {
		const supplied = readSuppliedCredentials(
			headers({ 'X-Mcp-Upstream-Cookie-TabroomToken': 'secret' })
		);
		expect(applySecurity(schemes, [{ cookieKey: [] }], supplied).cookies.TabroomToken).toBe(
			'secret'
		);
	});

	it('treats oauth2 as a bearer token', () => {
		const supplied = readSuppliedCredentials(
			headers({ 'X-Mcp-Upstream-Authorization': 'oauth-token' })
		);
		expect(applySecurity(schemes, [{ oauth: ['read'] }], supplied).headers.Authorization).toBe(
			'Bearer oauth-token'
		);
	});

	it('reports missing schemes when nothing was supplied', () => {
		const applied = applySecurity(
			schemes,
			[{ headerKey: [] }],
			readSuppliedCredentials(headers({}))
		);
		expect(applied.missing).toEqual(['headerKey']);
	});

	it('satisfies the first alternative it can and stops', () => {
		const supplied = readSuppliedCredentials(headers({ 'X-Mcp-Upstream-X-Api-Key': 'k' }));
		const applied = applySecurity(schemes, [{ bearerAuth: [] }, { headerKey: [] }], supplied);

		expect(applied.headers['X-Api-Key']).toBe('k');
		expect(applied.headers.Authorization).toBeUndefined();
		expect(applied.missing).toEqual([]);
	});

	it('treats an empty requirement entry as no auth required', () => {
		const applied = applySecurity(schemes, [{}], readSuppliedCredentials(headers({})));
		expect(applied.missing).toEqual([]);
	});

	it('uses a stored credential when the caller supplied none', () => {
		const stored = new Map([['bearerAuth', 'stored-token']]);
		const applied = applySecurity(
			schemes,
			[{ bearerAuth: [] }],
			readSuppliedCredentials(headers({})),
			stored
		);

		expect(applied.headers.Authorization).toBe('Bearer stored-token');
		expect(applied.missing).toEqual([]);
	});

	it('forwards unmatched upstream headers as an escape hatch', () => {
		const supplied = readSuppliedCredentials(headers({ 'X-Mcp-Upstream-X-Tenant': 'acme' }));
		expect(applySecurity(schemes, [], supplied).headers['X-Tenant']).toBe('acme');
	});
});

describe('effectiveSecurity', () => {
	it('prefers the operation requirements when present', () => {
		expect(effectiveSecurity([{ a: [] }], [{ b: [] }])).toEqual([{ a: [] }]);
	});

	it('treats an explicit empty array as opting out of document security', () => {
		expect(effectiveSecurity([], [{ b: [] }])).toEqual([]);
	});

	it('falls back to the document requirements when the operation declares none', () => {
		expect(effectiveSecurity(undefined, [{ b: [] }])).toEqual([{ b: [] }]);
	});
});

describe('isTrustedUpstream', () => {
	it('permits only hosts the description declares', () => {
		const declared = new Set(['api.example.com']);
		expect(isTrustedUpstream(new URL('https://api.example.com/x'), declared)).toBe(true);
		expect(isTrustedUpstream(new URL('https://evil.example.com/x'), declared)).toBe(false);
	});
});
