import { describe, expect, it } from 'vitest';
import { buildToolTable, preferredContentType, sanitizeToolName } from '../../src/openapi/tools';
import { makeDoc } from '../helpers';

describe('sanitizeToolName', () => {
	it('replaces characters MCP clients reject', () => {
		expect(sanitizeToolName('meta/root')).toBe('meta_root');
		expect(sanitizeToolName('security-advisories/list-global-advisories')).toBe(
			'security-advisories_list-global-advisories'
		);
		expect(sanitizeToolName('a b.c:d')).toBe('a_b_c_d');
	});

	it('trims leading and trailing separators', () => {
		expect(sanitizeToolName('__x__')).toBe('x');
		expect(sanitizeToolName('///')).toBe('operation');
	});
});

describe('buildToolTable', () => {
	it('generates one tool per operation with a valid client-safe name', () => {
		const table = buildToolTable(
			makeDoc({
				paths: {
					'/pets': {
						get: { operationId: 'pets/list', responses: {} },
						post: { operationId: 'pets/create', responses: {} }
					}
				}
			})
		);

		expect(table.tools.map((t) => t.name).sort()).toEqual(['pets_create', 'pets_list']);
		for (const tool of table.tools) {
			expect(tool.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
		}
	});

	it('keeps the original operationId as the title', () => {
		const table = buildToolTable(
			makeDoc({ paths: { '/x': { get: { operationId: 'meta/root', responses: {} } } } })
		);
		expect(table.tools[0]!.title).toBe('meta/root');
	});

	it('truncates long names to 64 characters and still disambiguates collisions', () => {
		const long = 'a'.repeat(80);
		const table = buildToolTable(
			makeDoc({
				paths: {
					'/one': { get: { operationId: `${long}1`, responses: {} } },
					'/two': { get: { operationId: `${long}2`, responses: {} } }
				}
			})
		);

		const names = table.tools.map((t) => t.name);
		expect(names).toHaveLength(2);
		expect(new Set(names).size).toBe(2);
		for (const name of names) expect(name.length).toBeLessThanOrEqual(64);
	});

	it('keeps both operations when operationIds collide rather than dropping one', () => {
		const table = buildToolTable(
			makeDoc({
				paths: {
					'/a': { get: { operationId: 'dup', responses: {} } },
					'/b': { get: { operationId: 'dup', responses: {} } }
				}
			})
		);

		expect(table.tools).toHaveLength(2);
		expect(new Set(table.tools.map((t) => t.name)).size).toBe(2);
		expect(table.tools.map((t) => t.path).sort()).toEqual(['/a', '/b']);
	});

	it('merges path-level parameters into each operation', () => {
		const table = buildToolTable(
			makeDoc({
				paths: {
					'/pets/{petId}': {
						parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
						get: { operationId: 'getPet', responses: {} },
						delete: { operationId: 'deletePet', responses: {} }
					}
				}
			})
		);

		for (const tool of table.tools) {
			expect(Object.keys(tool.inputSchema.properties)).toContain('petId');
			expect(tool.inputSchema.required).toContain('petId');
			expect(tool.bindings.petId).toMatchObject({ in: 'path', name: 'petId' });
		}
	});

	it('lets an operation-level parameter override the path-level one', () => {
		const table = buildToolTable(
			makeDoc({
				paths: {
					'/x/{id}': {
						parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
						get: {
							operationId: 'getX',
							parameters: [
								{
									name: 'id',
									in: 'path',
									required: true,
									schema: { type: 'integer' },
									description: 'numeric'
								}
							],
							responses: {}
						}
					}
				}
			})
		);

		expect(table.tools[0]!.inputSchema.properties.id.type).toBe('integer');
		expect(table.tools[0]!.inputSchema.properties.id.description).toBe('numeric');
	});

	it('uses the API parameter names directly and records where each belongs', () => {
		const table = buildToolTable(
			makeDoc({
				paths: {
					'/s': {
						get: {
							operationId: 'search',
							parameters: [
								{ name: 'q', in: 'query', schema: { type: 'string' } },
								{ name: 'X-Trace', in: 'header', schema: { type: 'string' } },
								{ name: 'session', in: 'cookie', schema: { type: 'string' } }
							],
							responses: {}
						}
					}
				}
			})
		);

		const tool = table.tools[0]!;
		expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(['X-Trace', 'q', 'session']);
		expect(tool.bindings.q!.in).toBe('query');
		expect(tool.bindings['X-Trace']!.in).toBe('header');
		expect(tool.bindings.session!.in).toBe('cookie');
	});

	it('disambiguates a parameter name that appears in two locations', () => {
		const table = buildToolTable(
			makeDoc({
				paths: {
					'/x/{id}': {
						get: {
							operationId: 'getX',
							parameters: [
								{ name: 'id', in: 'path', required: true, schema: { type: 'string' } },
								{ name: 'id', in: 'query', schema: { type: 'string' } }
							],
							responses: {}
						}
					}
				}
			})
		);

		const tool = table.tools[0]!;
		const names = Object.keys(tool.inputSchema.properties);
		expect(names).toHaveLength(2);
		expect(new Set(names).size).toBe(2);
		expect(names).toContain('id_path');
		expect(names).toContain('id_query');
		expect(tool.bindings.id_path!.name).toBe('id');
		expect(tool.bindings.id_query!.name).toBe('id');
	});

	it('keeps a parameter literally named body separate from the request body', () => {
		const table = buildToolTable(
			makeDoc({
				paths: {
					'/x': {
						post: {
							operationId: 'createX',
							parameters: [{ name: 'body', in: 'query', schema: { type: 'string' } }],
							requestBody: {
								required: true,
								content: { 'application/json': { schema: { type: 'object' } } }
							},
							responses: {}
						}
					}
				}
			})
		);

		const tool = table.tools[0]!;
		const names = Object.keys(tool.inputSchema.properties);
		expect(new Set(names).size).toBe(names.length);
		expect(names).toContain('body');
		expect(tool.bindings.body!.in).toBe('body');

		const queryBinding = Object.entries(tool.bindings).find(([, b]) => b.in === 'query');
		expect(queryBinding?.[1].name).toBe('body');
	});

	it('prefers application/json over other request content types', () => {
		expect(
			preferredContentType({
				'application/xml': {},
				'application/json': {},
				'application/x-www-form-urlencoded': {}
			})
		).toBe('application/json');

		expect(preferredContentType({ 'application/octet-stream': {} })).toBe(
			'application/octet-stream'
		);
		expect(preferredContentType({})).toBeUndefined();
	});

	it('derives an outputSchema from the 2xx JSON response', () => {
		const table = buildToolTable(
			makeDoc({
				paths: {
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
				}
			})
		);

		expect(table.tools[0]!.outputSchema).toMatchObject({ type: 'array' });
	});

	it('omits outputSchema when the caller disables it', () => {
		const doc = makeDoc({
			paths: {
				'/pets': {
					get: {
						operationId: 'listPets',
						responses: {
							'200': {
								description: 'ok',
								content: { 'application/json': { schema: { type: 'array' } } }
							}
						}
					}
				}
			}
		});

		expect(buildToolTable(doc, { outputSchema: false }).tools[0]!.outputSchema).toBeUndefined();
	});

	it('marks a parameterless tool as accepting no properties', () => {
		const table = buildToolTable(
			makeDoc({ paths: { '/ping': { get: { operationId: 'ping', responses: {} } } } })
		);
		expect(table.tools[0]!.inputSchema).toMatchObject({
			type: 'object',
			additionalProperties: false
		});
	});

	it('returns tools in a deterministic order across builds', () => {
		const doc = makeDoc({
			paths: {
				'/z': { get: { operationId: 'z', responses: {} } },
				'/a': { get: { operationId: 'a', responses: {} } },
				'/m': { post: { operationId: 'm', responses: {} } }
			}
		});

		const first = buildToolTable(doc).tools.map((t) => t.name);
		const second = buildToolTable(doc).tools.map((t) => t.name);
		expect(first).toEqual(second);
		expect(first).toEqual(['a', 'm', 'z']);
	});

	it('skips keys on a path item that are not HTTP methods', () => {
		const table = buildToolTable(
			makeDoc({
				paths: {
					'/x': {
						summary: 'not an operation',
						description: 'also not',
						get: { operationId: 'realOne', responses: {} }
					}
				}
			})
		);
		expect(table.tools.map((t) => t.name)).toEqual(['realOne']);
	});

	describe('filters', () => {
		const doc = makeDoc({
			paths: {
				'/pets': {
					get: { operationId: 'listPets', tags: ['pets'], responses: {} },
					post: { operationId: 'createPet', tags: ['pets'], responses: {} }
				},
				'/users': { get: { operationId: 'listUsers', tags: ['users'], responses: {} } }
			}
		});

		it('filters by tag', () => {
			expect(buildToolTable(doc, { tags: ['users'] }).tools.map((t) => t.name)).toEqual([
				'listUsers'
			]);
		});

		it('filters by method', () => {
			expect(buildToolTable(doc, { methods: ['post'] }).tools.map((t) => t.name)).toEqual([
				'createPet'
			]);
		});

		it('filters by include and exclude globs', () => {
			expect(
				buildToolTable(doc, { include: ['list*'] })
					.tools.map((t) => t.name)
					.sort()
			).toEqual(['listPets', 'listUsers']);
			expect(buildToolTable(doc, { exclude: ['*Pet*'] }).tools.map((t) => t.name)).toEqual([
				'listUsers'
			]);
		});

		it('caps the tool count', () => {
			expect(buildToolTable(doc, { max: 2 }).tools).toHaveLength(2);
		});
	});

	describe('untrusted description text', () => {
		it('strips control characters from descriptions lifted out of the document', () => {
			const table = buildToolTable(
				makeDoc({
					paths: {
						'/x': {
							get: {
								operationId: 'x',
								description: `harmless${String.fromCharCode(27)}[31m${String.fromCharCode(0x200b)}hidden`,
								responses: {}
							}
						}
					}
				})
			);

			expect(table.tools[0]!.description).toBe('harmlesshidden');
		});

		it('caps a very long description', () => {
			const table = buildToolTable(
				makeDoc({
					paths: {
						'/x': { get: { operationId: 'x', description: 'y'.repeat(50_000), responses: {} } }
					}
				})
			);
			expect((table.tools[0]!.description ?? '').length).toBeLessThanOrEqual(2000);
		});

		it('tells the model the descriptions are third-party data', () => {
			const table = buildToolTable(
				makeDoc({ paths: { '/x': { get: { operationId: 'x', responses: {} } } } })
			);
			expect(table.instructions).toContain('not authored by');
		});
	});

	it('stores a widely shared schema once instead of copying it into every tool', () => {
		const big = {
			type: 'object',
			properties: Object.fromEntries(
				Array.from({ length: 60 }, (_, i) => [`field${i}`, { type: 'string' }])
			)
		};

		const paths: Record<string, unknown> = {};
		for (let i = 0; i < 40; i++) {
			paths[`/p${i}`] = {
				post: {
					operationId: `op${i}`,
					requestBody: {
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Big' } } }
					},
					responses: {}
				}
			};
		}

		const table = buildToolTable(
			makeDoc({ components: { schemas: { Big: big as never } }, paths: paths as never })
		);

		expect(table.tools).toHaveLength(40);
		for (const tool of table.tools) {
			expect(tool.inputSchema.properties.body.$ref).toBe('#/$defs/Big');
			expect(tool.inputSchema.$defs.Big).toBeDefined();
		}

		// one copy per tool, not one copy per property; the whole table stays far below
		// the size the same document would reach if the schema were inlined everywhere
		const inlinedSize = JSON.stringify(big).length * 40;
		expect(JSON.stringify(table.tools).length).toBeLessThan(inlinedSize * 1.5);
	});

	it('gives each tool only the definitions it actually reaches', () => {
		const table = buildToolTable(
			makeDoc({
				components: {
					schemas: {
						Shared: { type: 'object', properties: { a: { type: 'string' } } },
						Other: { type: 'object', properties: { b: { type: 'string' } } }
					}
				},
				paths: {
					'/one': {
						post: {
							operationId: 'usesShared',
							requestBody: {
								content: { 'application/json': { schema: { $ref: '#/components/schemas/Shared' } } }
							},
							responses: {}
						},
						put: {
							operationId: 'alsoUsesShared',
							requestBody: {
								content: { 'application/json': { schema: { $ref: '#/components/schemas/Shared' } } }
							},
							responses: {}
						}
					},
					'/two': {
						post: {
							operationId: 'usesOther',
							requestBody: {
								content: { 'application/json': { schema: { $ref: '#/components/schemas/Other' } } }
							},
							responses: {}
						},
						put: {
							operationId: 'alsoUsesOther',
							requestBody: {
								content: { 'application/json': { schema: { $ref: '#/components/schemas/Other' } } }
							},
							responses: {}
						}
					}
				}
			})
		);

		const shared = table.byName.get('usesShared')!;
		expect(Object.keys(shared.inputSchema.$defs)).toEqual(['Shared']);

		const other = table.byName.get('usesOther')!;
		expect(Object.keys(other.inputSchema.$defs)).toEqual(['Other']);
	});

	it('attaches $defs to schemas that reference them', () => {
		const table = buildToolTable(
			makeDoc({
				components: {
					schemas: {
						Node: { type: 'object', properties: { child: { $ref: '#/components/schemas/Node' } } }
					}
				},
				paths: {
					'/n': {
						post: {
							operationId: 'createNode',
							requestBody: {
								required: true,
								content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } }
							},
							responses: {}
						}
					}
				}
			})
		);

		expect(table.tools[0]!.inputSchema.$defs).toBeDefined();
		expect(table.tools[0]!.inputSchema.$defs.Node).toBeDefined();
	});
});
