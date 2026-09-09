import { afterEach, describe, expect, it, vi } from 'vitest';
import { conformsShallow, executeCall, prepareRequest } from '../../src/openapi/call';
import { buildToolTable } from '../../src/openapi/tools';
import type { ToolDefinition } from '../../src/types';
import { makeDoc, stubFetch } from '../helpers';

const noCredentials = { headers: {}, query: {}, cookies: {}, missing: [] };

function toolFor(paths: Record<string, unknown>, name: string): ToolDefinition {
	const table = buildToolTable(makeDoc({ paths: paths as never }));
	const tool = table.byName.get(name);
	if (!tool) throw new Error(`no tool named ${name}`);
	return tool;
}

afterEach(() => vi.unstubAllGlobals());

describe('prepareRequest', () => {
	const tool = toolFor(
		{
			'/pets/{petId}': {
				get: {
					operationId: 'getPet',
					parameters: [
						{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } },
						{ name: 'verbose', in: 'query', schema: { type: 'boolean' } },
						{ name: 'X-Trace', in: 'header', schema: { type: 'string' } },
						{ name: 'session', in: 'cookie', schema: { type: 'string' } }
					],
					responses: {}
				}
			}
		},
		'getPet'
	);

	it('routes each argument to its declared location', () => {
		const request = prepareRequest(
			tool,
			{ petId: '7', verbose: true, 'X-Trace': 'abc', session: 'xyz' },
			'https://api.test.example',
			noCredentials
		);

		expect(request.url).toBe('https://api.test.example/pets/7?verbose=true');
		expect(request.headers['X-Trace']).toBe('abc');
		expect(request.headers['Cookie']).toBe('session=xyz');
	});

	it('omits arguments that were not supplied', () => {
		const request = prepareRequest(tool, { petId: '7' }, 'https://api.test.example', noCredentials);
		expect(request.url).toBe('https://api.test.example/pets/7');
		expect(request.headers['X-Trace']).toBeUndefined();
	});

	it('percent-encodes a path value containing a slash', () => {
		const request = prepareRequest(
			tool,
			{ petId: 'a/b' },
			'https://api.test.example',
			noCredentials
		);
		expect(request.url).toBe('https://api.test.example/pets/a%2Fb');
	});

	it('merges credentials into headers, query and cookies', () => {
		const request = prepareRequest(tool, { petId: '1' }, 'https://api.test.example', {
			headers: { Authorization: 'Bearer t' },
			query: { api_key: 'k' },
			cookies: { sid: 's' },
			missing: []
		});

		expect(request.headers['Authorization']).toBe('Bearer t');
		expect(request.url).toContain('api_key=k');
		expect(request.headers['Cookie']).toContain('sid=s');
	});

	it('sends no body on GET even when one is supplied', () => {
		const request = prepareRequest(
			tool,
			{ petId: '1', body: { a: 1 } },
			'https://api.test.example',
			noCredentials
		);
		expect(request.body).toBeUndefined();
	});

	it('encodes a JSON body on POST', () => {
		const post = toolFor(
			{
				'/pets': {
					post: {
						operationId: 'createPet',
						requestBody: {
							required: true,
							content: { 'application/json': { schema: { type: 'object' } } }
						},
						responses: {}
					}
				}
			},
			'createPet'
		);

		const request = prepareRequest(
			post,
			{ body: { name: 'Rex' } },
			'https://api.test.example',
			noCredentials
		);
		expect(request.headers['Content-Type']).toBe('application/json');
		expect(request.body).toBe('{"name":"Rex"}');
	});

	it('encodes a form body as urlencoded', () => {
		const post = toolFor(
			{
				'/f': {
					post: {
						operationId: 'submit',
						requestBody: {
							content: { 'application/x-www-form-urlencoded': { schema: { type: 'object' } } }
						},
						responses: {}
					}
				}
			},
			'submit'
		);

		const request = prepareRequest(
			post,
			{ body: { a: '1', b: 'x y' } },
			'https://api.test.example',
			noCredentials
		);
		expect(request.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
		expect(request.body).toBe('a=1&b=x+y');
	});
});

describe('executeCall', () => {
	const tool = toolFor(
		{ '/pets': { get: { operationId: 'listPets', responses: {} } } },
		'listPets'
	);

	it('returns JSON as text plus structured content', async () => {
		stubFetch({ 'https://api.test.example/pets': { body: '[{"id":1}]' } });

		const outcome = await executeCall(tool, {}, 'https://api.test.example', noCredentials);
		expect(outcome.result.isError).toBeFalsy();
		expect(outcome.result.content[0]).toMatchObject({ type: 'text', text: '[{"id":1}]' });
		expect(outcome.result.structuredContent).toEqual([{ id: 1 }]);
	});

	it('reports an upstream 404 as a tool error rather than throwing', async () => {
		stubFetch({
			'https://api.test.example/pets': { status: 404, body: '{"message":"nope"}' }
		});

		const outcome = await executeCall(tool, {}, 'https://api.test.example', noCredentials);
		expect(outcome.result.isError).toBe(true);
		expect(outcome.result.content[0]!.type).toBe('text');
		expect((outcome.result.content[0] as { text: string }).text).toContain('404');
		expect((outcome.result.content[0] as { text: string }).text).toContain('nope');
	});

	it('reports a 500 with the upstream body attached', async () => {
		stubFetch({ 'https://api.test.example/pets': { status: 500, body: 'boom' } });

		const outcome = await executeCall(tool, {}, 'https://api.test.example', noCredentials);
		expect(outcome.result.isError).toBe(true);
		expect((outcome.result.content[0] as { text: string }).text).toContain('boom');
	});

	it('handles 204 with no body', async () => {
		stubFetch({ 'https://api.test.example/pets': { status: 204 } });

		const outcome = await executeCall(tool, {}, 'https://api.test.example', noCredentials);
		expect(outcome.result.isError).toBeFalsy();
		expect(outcome.status).toBe(204);
	});

	it('returns an image response as an image content block', async () => {
		stubFetch({
			'https://api.test.example/pets': { body: 'binary', headers: { 'Content-Type': 'image/png' } }
		});

		const outcome = await executeCall(tool, {}, 'https://api.test.example', noCredentials);
		expect(outcome.result.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
	});

	it('returns other binary content as an embedded resource', async () => {
		stubFetch({
			'https://api.test.example/pets': {
				body: 'zipdata',
				headers: { 'Content-Type': 'application/zip' }
			}
		});

		const outcome = await executeCall(tool, {}, 'https://api.test.example', noCredentials);
		expect(outcome.result.content[0]!.type).toBe('resource');
	});

	it('returns plain text as text without structured content', async () => {
		stubFetch({
			'https://api.test.example/pets': { body: 'hello', headers: { 'Content-Type': 'text/plain' } }
		});

		const outcome = await executeCall(tool, {}, 'https://api.test.example', noCredentials);
		expect(outcome.result.content[0]).toMatchObject({ type: 'text', text: 'hello' });
		expect(outcome.result.structuredContent).toBeUndefined();
	});

	it('refuses a response past the size cap', async () => {
		stubFetch({ 'https://api.test.example/pets': { body: 'x'.repeat(5000) } });

		const outcome = await executeCall(tool, {}, 'https://api.test.example', noCredentials, {
			maxResponseBytes: 100
		});
		expect(outcome.result.isError).toBe(true);
		expect((outcome.result.content[0] as { text: string }).text).toContain('more than 100 bytes');
	});

	it('reports a blocked upstream host as a tool error', async () => {
		const outcome = await executeCall(tool, {}, 'https://169.254.169.254', noCredentials);
		expect(outcome.result.isError).toBe(true);
		expect((outcome.result.content[0] as { text: string }).text).toContain('network policy');
	});

	it('surfaces an async job pointer from a 202 response', async () => {
		stubFetch({
			'https://api.test.example/pets': {
				status: 202,
				headers: { Location: 'https://api.test.example/jobs/1', 'Retry-After': '3' }
			}
		});

		const outcome = await executeCall(tool, {}, 'https://api.test.example', noCredentials);
		expect(outcome.status).toBe(202);
		expect(outcome.location).toBe('https://api.test.example/jobs/1');
		expect(outcome.retryAfterMs).toBe(3000);
	});

	it('sends the request the tool describes', async () => {
		const stub = stubFetch({ 'https://api.test.example/pets': { body: '[]' } });
		await executeCall(tool, {}, 'https://api.test.example', {
			headers: { 'X-Api-Key': 'k' },
			query: {},
			cookies: {},
			missing: []
		});

		expect(stub.requests[0]!.method).toBe('GET');
		expect(stub.requests[0]!.url).toBe('https://api.test.example/pets');
		expect(stub.requests[0]!.headers['x-api-key']).toBe('k');
	});
});

describe('conformsShallow', () => {
	it('accepts a value matching the declared type', () => {
		expect(conformsShallow([], { type: 'array' })).toBe(true);
		expect(conformsShallow({}, { type: 'object' })).toBe(true);
		expect(conformsShallow(1, { type: 'integer' })).toBe(true);
		expect(conformsShallow(1.5, { type: 'number' })).toBe(true);
		expect(conformsShallow(1, { type: 'number' })).toBe(true);
		expect(conformsShallow(null, { type: 'null' })).toBe(true);
	});

	it('rejects a value of the wrong shape', () => {
		expect(conformsShallow([], { type: 'object' })).toBe(false);
		expect(conformsShallow({}, { type: 'array' })).toBe(false);
	});

	it('accepts anything when the schema declares no type', () => {
		expect(conformsShallow({ a: 1 }, {})).toBe(true);
	});

	it('omits structured content when the response contradicts the output schema', async () => {
		const typed = toolFor(
			{
				'/pets': {
					get: {
						operationId: 'listPets',
						responses: {
							'200': {
								description: 'ok',
								content: {
									'application/json': { schema: { type: 'array', items: { type: 'string' } } }
								}
							}
						}
					}
				}
			},
			'listPets'
		);

		stubFetch({ 'https://api.test.example/pets': { body: '{"not":"an array"}' } });

		const outcome = await executeCall(typed, {}, 'https://api.test.example', noCredentials);
		expect(outcome.result.structuredContent).toBeUndefined();
		expect(outcome.result.content[0]!.type).toBe('text');
	});
});
