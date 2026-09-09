import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env';
import {
	ResolveError,
	clearToolTableCache,
	credentialHosts,
	getToolTable,
	knownAliases,
	loadSpec,
	normalizeSpec,
	resolveBaseUrl,
	resolveServerToken
} from '../../src/resolve';
import { stubFetch } from '../helpers';

const env: Env = {};

const YAML_SPEC = `openapi: 3.1.0
info:
  title: YAML API
  description: described in yaml
  version: 1.2.3
servers:
  - url: https://api.yaml.example/v2
paths:
  /things:
    get:
      operationId: listThings
      responses:
        '200':
          description: ok
`;

const SWAGGER2_SPEC = JSON.stringify({
	swagger: '2.0',
	info: { title: 'Old API', version: '1.0' },
	host: 'api.old.example',
	basePath: '/v1',
	paths: {
		'/things': { get: { operationId: 'listThings', responses: { '200': { description: 'ok' } } } }
	}
});

beforeEach(() => clearToolTableCache());
afterEach(() => clearToolTableCache());

describe('resolveServerToken', () => {
	it('resolves a known alias', () => {
		expect(resolveServerToken('petstore', env)).toContain('petstore3.swagger.io');
	});

	it('passes an https URL through', () => {
		expect(resolveServerToken('https://x.example/openapi.json', env)).toBe(
			'https://x.example/openapi.json'
		);
	});

	it('assumes https for a bare hostname', () => {
		expect(resolveServerToken('api.example.com', env)).toBe('https://api.example.com');
		expect(resolveServerToken('api.example.com/openapi.json', env)).toBe(
			'https://api.example.com/openapi.json'
		);
	});

	it('rejects http', () => {
		expect(() => resolveServerToken('http://x.example/spec', env)).toThrow(ResolveError);
	});

	it('rejects an unknown single-word alias', () => {
		expect(() => resolveServerToken('nosuchthing', env)).toThrow(ResolveError);
	});

	it('rejects an empty token', () => {
		expect(() => resolveServerToken('  ', env)).toThrow(ResolveError);
	});

	it('honours allowlist-only mode', () => {
		const locked: Env = { ALLOWLIST_ONLY: '1' };
		expect(resolveServerToken('petstore', locked)).toContain('petstore3');
		expect(() => resolveServerToken('https://x.example/spec', locked)).toThrow(ResolveError);
	});

	it('lists the aliases it ships with', () => {
		const aliases = knownAliases();
		expect(aliases).toContain('tabroom');
		expect(aliases).toContain('petstore');
		expect(aliases).toEqual([...aliases].sort());
	});
});

describe('normalizeSpec', () => {
	it('accepts an OpenAPI 3 document', () => {
		expect(normalizeSpec({ openapi: '3.1.0', info: { title: 'x' }, paths: {} })).toBeDefined();
	});

	it('converts a Swagger 2.0 document', () => {
		const doc = normalizeSpec(JSON.parse(SWAGGER2_SPEC));
		expect(doc?.openapi.startsWith('3.')).toBe(true);
		expect(doc?.servers?.[0]?.url).toBe('https://api.old.example/v1');
	});

	it('accepts a document with webhooks but no paths', () => {
		expect(normalizeSpec({ openapi: '3.1.0', info: { title: 'x' }, webhooks: {} })).toBeDefined();
	});

	it('rejects anything that is not a description', () => {
		expect(normalizeSpec({ hello: 'world' })).toBeUndefined();
		expect(normalizeSpec(null)).toBeUndefined();
		expect(normalizeSpec('a string')).toBeUndefined();
	});

	it('does not require servers, which resolve against the document origin', () => {
		expect(normalizeSpec({ openapi: '3.1.0', info: { title: 'x' }, paths: {} })).toBeDefined();
	});
});

describe('loadSpec', () => {
	it('parses a YAML description', async () => {
		stubFetch({
			'https://api.yaml.example/openapi.yaml': {
				body: YAML_SPEC,
				headers: { 'Content-Type': 'application/yaml' }
			}
		});

		const loaded = await loadSpec('https://api.yaml.example/openapi.yaml', env);
		expect(loaded.doc.info.title).toBe('YAML API');
		expect(loaded.doc.paths?.['/things']?.get?.operationId).toBe('listThings');
	});

	it('converts a Swagger 2.0 description on load', async () => {
		stubFetch({ 'https://api.old.example/swagger.json': { body: SWAGGER2_SPEC } });

		const loaded = await loadSpec('https://api.old.example/swagger.json', env);
		expect(loaded.doc.openapi.startsWith('3.')).toBe(true);
	});

	it('refuses a description larger than the cap', async () => {
		stubFetch({ 'https://api.big.example/spec': { body: 'x'.repeat(10_000) } });

		await expect(
			loadSpec('https://api.big.example/spec', { MAX_SPEC_BYTES: '100' })
		).rejects.toThrow();
	});

	it('reports a fetch failure', async () => {
		stubFetch({ 'https://api.gone.example/spec': { status: 503, body: 'down' } });

		await expect(loadSpec('https://api.gone.example/spec', env)).rejects.toThrow(ResolveError);
	});
});

describe('getToolTable caching', () => {
	const SPEC = JSON.stringify({
		openapi: '3.1.0',
		info: { title: 'Cached API', description: 'c', version: '1.0.0' },
		servers: [{ url: 'https://api.cached.example' }],
		paths: { '/a': { get: { operationId: 'a', responses: {} } } }
	});

	it('reuses a built table rather than refetching', async () => {
		const stub = stubFetch({ 'https://api.cached.example/spec': { body: SPEC } });

		await getToolTable('https://api.cached.example/spec', {}, env);
		await getToolTable('https://api.cached.example/spec', {}, env);

		expect(stub.requests).toHaveLength(1);
	});

	it('collapses concurrent cold misses into one build', async () => {
		const stub = stubFetch({ 'https://api.cached.example/spec': { body: SPEC } });

		await Promise.all([
			getToolTable('https://api.cached.example/spec', {}, env),
			getToolTable('https://api.cached.example/spec', {}, env),
			getToolTable('https://api.cached.example/spec', {}, env)
		]);

		expect(stub.requests).toHaveLength(1);
	});

	it('keys the cache by filter, not just by URL', async () => {
		const stub = stubFetch({ 'https://api.cached.example/spec': { body: SPEC } });

		await getToolTable('https://api.cached.example/spec', { tags: ['x'] }, env);
		await getToolTable('https://api.cached.example/spec', { tags: ['y'] }, env);

		expect(stub.requests).toHaveLength(2);
	});
});

describe('resolveBaseUrl', () => {
	const table = {
		tools: [],
		byName: new Map(),
		serverInfo: { name: 'x', version: '1' },
		securitySchemes: {},
		security: [],
		servers: [{ url: '/api/v3' }, { url: 'https://second.example' }]
	};

	it('resolves a relative server against the description origin', () => {
		expect(resolveBaseUrl(table, 'https://petstore.example/api/v3/openapi.json')).toBe(
			'https://petstore.example/api/v3'
		);
	});

	it('selects an alternative server by index', () => {
		expect(resolveBaseUrl(table, 'https://petstore.example/openapi.json', 1)).toBe(
			'https://second.example'
		);
	});

	it('falls back to the origin when there are no servers', () => {
		expect(resolveBaseUrl({ ...table, servers: [] }, 'https://only.example/spec.json')).toBe(
			'https://only.example'
		);
	});

	it('substitutes server variables', () => {
		const varied = {
			...table,
			servers: [{ url: 'https://{region}.api.example', variables: { region: { default: 'eu' } } }]
		};
		expect(resolveBaseUrl(varied, 'https://x.example/spec')).toBe('https://eu.api.example');
	});
});

describe('credentialHosts', () => {
	const table = {
		tools: [],
		byName: new Map(),
		serverInfo: { name: 'x', version: '1' },
		securitySchemes: {},
		security: [],
		servers: [{ url: 'https://api.declared.example/v1' }]
	};

	it('includes the declared server host and the description host', () => {
		const hosts = credentialHosts(table, 'https://docs.declared.example/openapi.json', env);
		expect(hosts.has('api.declared.example')).toBe(true);
		expect(hosts.has('docs.declared.example')).toBe(true);
	});

	it('excludes a host the description never mentions', () => {
		const hosts = credentialHosts(table, 'https://docs.declared.example/openapi.json', env);
		expect(hosts.has('evil.example')).toBe(false);
	});

	it('includes hosts configured for the deployment', () => {
		const hosts = credentialHosts(table, 'https://docs.declared.example/spec', {
			ALLOWED_HOSTS: 'extra.example, another.example'
		});
		expect(hosts.has('extra.example')).toBe(true);
		expect(hosts.has('another.example')).toBe(true);
	});
});
