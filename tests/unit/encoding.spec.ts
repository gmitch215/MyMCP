import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env';
import worker from '../../src/index';
import { encodeBody, fromBase64, toBase64 } from '../../src/openapi/call';
import { convertSwagger2 } from '../../src/openapi/swagger2';
import { buildToolTable } from '../../src/openapi/tools';
import { clearToolTableCache } from '../../src/resolve';
import { mcpHeaders, rpc, stubFetch } from '../helpers';

afterEach(() => vi.unstubAllGlobals());

describe('base64 helpers', () => {
	it('round-trips bytes', () => {
		const bytes = new Uint8Array([0, 1, 127, 128, 255]);
		expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
	});

	it('handles a large buffer without blowing the call stack', () => {
		const bytes = new Uint8Array(200_000).fill(65);
		expect(fromBase64(toBase64(bytes)).length).toBe(200_000);
	});
});

describe('encodeBody', () => {
	it('returns undefined for an absent body', () => {
		expect(encodeBody(undefined, 'application/json')).toBeUndefined();
	});

	it('serializes JSON', () => {
		expect(encodeBody({ a: 1 }, 'application/json')).toEqual({
			body: '{"a":1}',
			contentType: 'application/json'
		});
	});

	it('ignores parameters on the content type', () => {
		expect(encodeBody({ a: 1 }, 'application/json; charset=utf-8')?.contentType).toBe(
			'application/json'
		);
	});

	it('serializes urlencoded form fields, expanding arrays', () => {
		const encoded = encodeBody(
			{ a: '1', tags: ['x', 'y'], obj: { k: 1 } },
			'application/x-www-form-urlencoded'
		);
		expect(encoded?.body).toBe('a=1&tags=x&tags=y&obj=%7B%22k%22%3A1%7D');
	});

	it('skips null and undefined form fields', () => {
		expect(
			encodeBody({ a: '1', b: null, c: undefined }, 'application/x-www-form-urlencoded')?.body
		).toBe('a=1');
	});

	it('builds multipart form data and leaves the content type to fetch', () => {
		const encoded = encodeBody({ caption: 'hi' }, 'multipart/form-data');
		expect(encoded?.contentType).toBe('');
		expect(encoded?.body).toBeInstanceOf(FormData);
	});

	it('treats a long base64 multipart field as a file', () => {
		const payload = toBase64(new Uint8Array(200).fill(7));
		const encoded = encodeBody({ file: payload }, 'multipart/form-data');
		const form = encoded?.body as FormData;

		expect(form.get('file')).toBeInstanceOf(Blob);
	});

	it('decodes a base64 octet-stream body to bytes', () => {
		const encoded = encodeBody(toBase64(new Uint8Array([1, 2, 3])), 'application/octet-stream');
		expect(encoded?.body).toBeInstanceOf(Uint8Array);
		expect(encoded?.contentType).toBe('application/octet-stream');
	});

	it('passes a non-base64 octet-stream body through as text', () => {
		expect(encodeBody('!!not base64!!', 'application/octet-stream')?.body).toBe('!!not base64!!');
	});

	it('serializes a non-string octet-stream body as JSON', () => {
		expect(encodeBody({ a: 1 }, 'application/octet-stream')?.body).toBe('{"a":1}');
	});

	it('passes text and XML bodies through', () => {
		expect(encodeBody('<a/>', 'application/xml')).toEqual({
			body: '<a/>',
			contentType: 'application/xml'
		});
		expect(encodeBody('plain', 'text/plain')?.body).toBe('plain');
		expect(encodeBody({ a: 1 }, 'text/plain')?.body).toBe('{"a":1}');
	});

	it('defaults an unknown content type to JSON serialization', () => {
		expect(encodeBody({ a: 1 }, '')?.contentType).toBe('application/json');
	});
});

describe('Swagger 2.0 shared components', () => {
	const doc = convertSwagger2({
		swagger: '2.0',
		info: { title: 'Shared', version: '1' },
		host: 'api.shared.example',
		produces: ['application/json'],
		parameters: {
			PerPage: { name: 'per_page', in: 'query', type: 'integer' },
			BodyOnly: { name: 'body', in: 'body', schema: { type: 'object' } }
		},
		responses: {
			NotFound: { description: 'missing', schema: { type: 'object' } },
			NoSchema: { description: 'nothing' }
		},
		definitions: { Thing: { type: 'object' } },
		paths: {
			'/things/{id}': {
				parameters: [
					{ name: 'id', in: 'path', type: 'string', required: true },
					{ name: 'ignored', in: 'body', schema: {} }
				],
				get: {
					operationId: 'getThing',
					parameters: [
						{ $ref: '#/parameters/PerPage' },
						{
							name: 'tags',
							in: 'query',
							type: 'array',
							collectionFormat: 'tsv',
							items: { type: 'string' }
						},
						{
							name: 'ssv',
							in: 'query',
							type: 'array',
							collectionFormat: 'ssv',
							items: { type: 'string' }
						},
						{
							name: 'pipes',
							in: 'query',
							type: 'array',
							collectionFormat: 'pipes',
							items: { type: 'string' }
						}
					],
					responses: { '404': { $ref: '#/responses/NotFound' } }
				}
			}
		}
	});

	it('promotes global parameters into components', () => {
		expect(doc.components?.parameters?.PerPage?.name).toBe('per_page');
	});

	it('drops a global body parameter, which has no OpenAPI 3 equivalent', () => {
		expect(doc.components?.parameters?.BodyOnly).toBeUndefined();
	});

	it('promotes global responses into components', () => {
		expect(doc.components?.responses?.NotFound?.content?.['application/json']).toBeDefined();
		expect(doc.components?.responses?.NoSchema?.content).toBeUndefined();
	});

	it('keeps a path-level parameter and drops a path-level body parameter', () => {
		const names = doc.paths?.['/things/{id}']?.parameters?.map((p) => p.name);
		expect(names).toEqual(['id']);
	});

	it('maps every collectionFormat it supports', () => {
		const params = doc.paths?.['/things/{id}']?.get?.parameters ?? [];
		const byName = Object.fromEntries(params.map((p) => [p.name, p]));

		expect(byName.ssv).toMatchObject({ style: 'spaceDelimited', explode: false });
		expect(byName.pipes).toMatchObject({ style: 'pipeDelimited', explode: false });
		expect(byName.tags).toMatchObject({ style: 'form', explode: false });
	});

	it('rewrites a response $ref onto the components path', () => {
		const response = doc.paths?.['/things/{id}']?.get?.responses?.['404'];
		expect((response as { $ref?: string }).$ref).toBe('#/components/responses/NotFound');
	});

	it('resolves the referenced parameter when building tools', () => {
		const table = buildToolTable(doc);
		const tool = table.byName.get('getThing')!;
		expect(Object.keys(tool.inputSchema.properties)).toContain('per_page');
	});
});

describe('subscriptions/listen', () => {
	const SPEC = JSON.stringify({
		openapi: '3.1.0',
		info: { title: 'Sub API', description: 's', version: '1' },
		servers: [{ url: 'https://api.sub.example' }],
		paths: { '/x': { get: { operationId: 'x', responses: {} } } }
	});
	const SPEC_URL = 'https://api.sub.example/openapi.json';
	const MCP = `https://mymcp.test/${encodeURIComponent(SPEC_URL)}/mcp`;

	const env: Env = {};
	const ctx = {
		waitUntil: () => undefined,
		passThroughOnException: () => undefined
	} as unknown as ExecutionContext;

	beforeEach(() => {
		clearToolTableCache();
		stubFetch({ [SPEC_URL]: { body: SPEC } });
	});

	it('opens a stream and acknowledges the subscription', async () => {
		const response = await worker.fetch(
			new Request(MCP, {
				method: 'POST',
				headers: mcpHeaders('subscriptions/listen'),
				body: rpc('subscriptions/listen', { notifications: { toolsListChanged: true } })
			}),
			env,
			ctx
		);

		expect(response.headers.get('Content-Type')).toBe('text/event-stream');
		expect(response.headers.get('X-Accel-Buffering')).toBe('no');

		// the stream stays open for change notifications, so read what is buffered and stop
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let text = '';

		while (!text.includes('"result"')) {
			const { done, value } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
		await reader.cancel();

		expect(text).toContain('notifications/subscriptions/acknowledged');
		expect(text).toContain('toolsListChanged');
	});
});
