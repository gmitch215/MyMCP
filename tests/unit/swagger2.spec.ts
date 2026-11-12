import { describe, expect, it } from 'vitest';
import { convertSwagger2 } from '../../src/openapi/swagger2';
import { buildToolTable } from '../../src/openapi/tools';
import { isValidOpenAPI } from '../../src/types';

const swagger2 = {
	swagger: '2.0',
	info: { title: 'Legacy API', description: 'A 2.0 API', version: '1.0' },
	host: 'api.legacy.example',
	basePath: '/v1',
	schemes: ['https', 'http'],
	consumes: ['application/json'],
	produces: ['application/json'],
	securityDefinitions: {
		basicAuth: { type: 'basic' },
		apiKey: { type: 'apiKey', name: 'X-Api-Key', in: 'header' },
		oauth: {
			type: 'oauth2',
			flow: 'accessCode',
			authorizationUrl: 'https://auth.legacy.example/authorize',
			tokenUrl: 'https://auth.legacy.example/token',
			scopes: { read: 'Read' }
		}
	},
	definitions: {
		Pet: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } }
	},
	paths: {
		'/pets': {
			get: {
				operationId: 'listPets',
				parameters: [
					{ name: 'limit', in: 'query', type: 'integer', required: false },
					{
						name: 'tags',
						in: 'query',
						type: 'array',
						collectionFormat: 'multi',
						items: { type: 'string' }
					}
				],
				responses: {
					'200': {
						description: 'ok',
						schema: { type: 'array', items: { $ref: '#/definitions/Pet' } }
					}
				}
			},
			post: {
				operationId: 'createPet',
				parameters: [
					{ name: 'body', in: 'body', required: true, schema: { $ref: '#/definitions/Pet' } }
				],
				responses: { '201': { description: 'created' } }
			}
		},
		'/pets/{petId}/photo': {
			post: {
				operationId: 'uploadPhoto',
				consumes: ['multipart/form-data'],
				parameters: [
					{ name: 'petId', in: 'path', type: 'string', required: true },
					{ name: 'file', in: 'formData', type: 'file', required: true },
					{ name: 'caption', in: 'formData', type: 'string' }
				],
				responses: { '200': { description: 'ok' } }
			}
		}
	}
};

describe('convertSwagger2 edge cases', () => {
	const base = { swagger: '2.0', info: { title: 'Edge', version: '1' }, paths: {} };

	it('maps each OAuth2 flow to its OpenAPI 3 name', () => {
		const doc = convertSwagger2({
			...base,
			securityDefinitions: {
				app: { type: 'oauth2', flow: 'application', tokenUrl: 'https://t', scopes: {} },
				code: {
					type: 'oauth2',
					flow: 'accessCode',
					authorizationUrl: 'https://a',
					tokenUrl: 'https://t',
					scopes: {}
				},
				impl: { type: 'oauth2', flow: 'implicit', authorizationUrl: 'https://a', scopes: {} },
				pass: { type: 'oauth2', flow: 'password', tokenUrl: 'https://t', scopes: {} }
			}
		} as never) as any;

		const schemes = doc.components.securitySchemes;
		expect(Object.keys(schemes.app.flows)).toEqual(['clientCredentials']);
		expect(Object.keys(schemes.code.flows)).toEqual(['authorizationCode']);
		expect(Object.keys(schemes.impl.flows)).toEqual(['implicit']);
		expect(Object.keys(schemes.pass.flows)).toEqual(['password']);
	});

	it('maps a basic security definition to HTTP basic auth', () => {
		const doc = convertSwagger2({
			...base,
			securityDefinitions: { b: { type: 'basic' } }
		} as never) as any;

		expect(doc.components.securitySchemes.b).toMatchObject({ type: 'http', scheme: 'basic' });
	});

	it('uses http when a description offers no https scheme', () => {
		const doc = convertSwagger2({
			...base,
			host: 'plain.example',
			schemes: ['http']
		} as never) as any;

		expect(doc.servers[0].url).toBe('http://plain.example');
	});

	it('defaults a body parameter to application/json when no consumes are declared', () => {
		const doc = convertSwagger2({
			...base,
			paths: {
				'/x': {
					post: {
						operationId: 'postX',
						parameters: [{ name: 'body', in: 'body', schema: { type: 'object' } }],
						responses: {}
					}
				}
			}
		} as never) as any;

		expect(doc.paths['/x'].post.requestBody.content).toHaveProperty('application/json');
	});

	it('maps a file form field to a binary string under multipart', () => {
		const doc = convertSwagger2({
			...base,
			consumes: ['multipart/form-data'],
			paths: {
				'/upload': {
					post: {
						operationId: 'upload',
						parameters: [{ name: 'avatar', in: 'formData', type: 'file', required: true }],
						responses: {}
					}
				}
			}
		} as never) as any;

		const schema = doc.paths['/upload'].post.requestBody.content['multipart/form-data'].schema;
		expect(schema.properties.avatar).toMatchObject({ type: 'string', format: 'binary' });
		expect(schema.required).toEqual(['avatar']);
	});

	it('rewrites a parameter that is itself a reference', () => {
		const doc = convertSwagger2({
			...base,
			paths: {
				'/x': {
					get: { operationId: 'getX', parameters: [{ $ref: '#/parameters/Page' }], responses: {} }
				}
			}
		} as never) as any;

		expect(doc.paths['/x'].get.parameters[0]).toEqual({ $ref: '#/components/parameters/Page' });
	});
});

describe('convertSwagger2', () => {
	const doc = convertSwagger2(swagger2);

	it('produces a valid OpenAPI 3 document', () => {
		expect(doc.openapi.startsWith('3.')).toBe(true);
		expect(isValidOpenAPI(doc)).toBe(true);
	});

	it('builds servers from host, basePath and schemes, preferring https', () => {
		expect(doc.servers).toEqual([{ url: 'https://api.legacy.example/v1' }]);
	});

	it('moves definitions to components.schemas and rewrites their pointers', () => {
		expect(doc.components?.schemas?.Pet).toBeDefined();
		const listPets = doc.paths?.['/pets']?.get;
		const schema = listPets?.responses?.['200']?.content?.['application/json']?.schema;
		expect(JSON.stringify(schema)).toContain('#/components/schemas/Pet');
		expect(JSON.stringify(schema)).not.toContain('#/definitions/');
	});

	it('turns a body parameter into a requestBody', () => {
		const post = doc.paths?.['/pets']?.post;
		expect(post?.requestBody?.required).toBe(true);
		expect(post?.requestBody?.content?.['application/json']).toBeDefined();
		expect(post?.parameters ?? []).toHaveLength(0);
	});

	it('turns formData parameters into a multipart requestBody', () => {
		const post = doc.paths?.['/pets/{petId}/photo']?.post;
		const media = post?.requestBody?.content?.['multipart/form-data'];
		expect(media?.schema?.properties?.file).toMatchObject({ type: 'string', format: 'binary' });
		expect(media?.schema?.required).toContain('file');
		expect(post?.parameters?.map((p) => p.name)).toEqual(['petId']);
	});

	it('lifts a bare parameter type into a schema', () => {
		const limit = doc.paths?.['/pets']?.get?.parameters?.find((p) => p.name === 'limit');
		expect(limit?.schema).toMatchObject({ type: 'integer' });
	});

	it('maps collectionFormat onto style and explode', () => {
		const tags = doc.paths?.['/pets']?.get?.parameters?.find((p) => p.name === 'tags');
		expect(tags).toMatchObject({ style: 'form', explode: true });
	});

	it('converts every security definition kind', () => {
		const schemes = doc.components?.securitySchemes ?? {};
		expect(schemes.basicAuth).toMatchObject({ type: 'http', scheme: 'basic' });
		expect(schemes.apiKey).toMatchObject({ type: 'apiKey', name: 'X-Api-Key', in: 'header' });
		expect(schemes.oauth?.type).toBe('oauth2');
		expect(schemes.oauth?.flows?.authorizationCode?.tokenUrl).toBe(
			'https://auth.legacy.example/token'
		);
	});

	it('marks path parameters required even when the source omitted it', () => {
		const petId = doc.paths?.['/pets/{petId}/photo']?.post?.parameters?.find(
			(p) => p.name === 'petId'
		);
		expect(petId?.required).toBe(true);
	});

	it('produces a working tool table', () => {
		const table = buildToolTable(doc);
		expect(table.tools.map((t) => t.name).sort()).toEqual(['createPet', 'listPets', 'uploadPhoto']);

		const upload = table.byName.get('uploadPhoto')!;
		expect(upload.requestContentType).toBe('multipart/form-data');
		expect(upload.bindings.petId).toMatchObject({ in: 'path' });
	});

	it('passes a non-Swagger document through untouched', () => {
		const openapi = { openapi: '3.1.0', info: { title: 'x' }, paths: {} };
		expect(convertSwagger2(openapi)).toBe(openapi);
	});

	it('falls back to basePath alone when no host is declared', () => {
		const converted = convertSwagger2({ ...swagger2, host: undefined });
		expect(converted.servers).toEqual([{ url: '/v1' }]);
	});
});
