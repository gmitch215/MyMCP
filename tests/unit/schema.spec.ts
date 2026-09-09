import { describe, expect, it } from 'vitest';
import { SchemaResolver, sanitizeText } from '../../src/openapi/schema';
import { makeDoc } from '../helpers';

const recursiveDoc = makeDoc({
	components: {
		schemas: {
			Node: {
				type: 'object',
				properties: {
					name: { type: 'string' },
					children: { type: 'array', items: { $ref: '#/components/schemas/Node' } },
					parent: { $ref: '#/components/schemas/Node' }
				}
			},
			Pair: {
				type: 'object',
				properties: {
					left: { $ref: '#/components/schemas/Node' },
					right: { $ref: '#/components/schemas/Node' }
				}
			}
		}
	}
});

describe('SchemaResolver', () => {
	it('inlines a component referenced only once', () => {
		const doc = makeDoc({
			components: {
				schemas: { Solo: { type: 'object', properties: { name: { type: 'string' } } } }
			}
		});
		const result = new SchemaResolver(doc).resolve({ $ref: '#/components/schemas/Solo' });

		expect(result.type).toBe('object');
		expect(result.properties.name).toEqual({ type: 'string' });
	});

	it('hoists a schema reached from several places instead of copying it', () => {
		const resolver = new SchemaResolver(recursiveDoc);
		const result = resolver.resolve({ $ref: '#/components/schemas/Node' });

		expect(result.$ref).toBe('#/$defs/Node');

		const defs = resolver.defsBlock();
		expect(defs).toBeDefined();
		expect(defs!.Node!.type).toBe('object');
		expect(defs!.Node!.properties.name).toEqual({ type: 'string' });
	});

	it('terminates on a self-referential schema and points the cycle at $defs', () => {
		const resolver = new SchemaResolver(recursiveDoc);
		resolver.resolve({ $ref: '#/components/schemas/Node' });

		const node = resolver.defsBlock()!.Node!;
		expect(node.properties.parent.$ref).toBe('#/$defs/Node');
		expect(node.properties.children.items.$ref).toBe('#/$defs/Node');
	});

	it('leaves no dangling pointer: every $ref target exists in $defs', () => {
		const resolver = new SchemaResolver(recursiveDoc);
		const result = resolver.resolve({ $ref: '#/components/schemas/Pair' });
		const defs = resolver.defsBlock() ?? {};

		const refs: string[] = [];
		const walk = (node: unknown) => {
			if (Array.isArray(node)) return node.forEach(walk);
			if (!node || typeof node !== 'object') return;
			for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
				if (key === '$ref' && typeof value === 'string') refs.push(value);
				else walk(value);
			}
		};
		walk(result);
		walk(defs);

		expect(refs.length).toBeGreaterThan(0);
		for (const ref of refs) {
			expect(ref.startsWith('#/$defs/')).toBe(true);
			expect(defs[ref.slice('#/$defs/'.length)]).toBeDefined();
		}
	});

	it('does not mutate the source document', () => {
		const doc = makeDoc({
			components: {
				schemas: {
					A: { type: 'object', properties: { b: { $ref: '#/components/schemas/B' } } },
					B: { type: 'string' }
				}
			}
		});
		const snapshot = JSON.stringify(doc);

		new SchemaResolver(doc).resolve({ $ref: '#/components/schemas/A' });

		expect(JSON.stringify(doc)).toBe(snapshot);
	});

	it('resolves a reference into components/parameters instead of throwing', () => {
		const doc = makeDoc({
			components: {
				parameters: {
					PerPage: { name: 'per_page', in: 'query', schema: { type: 'integer', maximum: 100 } }
				},
				schemas: {
					Wrapper: {
						type: 'object',
						properties: { p: { $ref: '#/components/parameters/PerPage' } }
					}
				}
			}
		});

		const result = new SchemaResolver(doc).resolve({ $ref: '#/components/schemas/Wrapper' });
		expect(result.properties.p.name).toBe('per_page');
	});

	it('returns a permissive schema for an unresolvable reference rather than throwing', () => {
		const doc = makeDoc({ components: { schemas: {} } });
		const resolver = new SchemaResolver(doc);

		expect(resolver.resolve({ $ref: '#/components/schemas/Missing' })).toEqual({});
		expect(resolver.resolve({ $ref: 'https://other.example/spec.json#/Thing' })).toEqual({});
	});

	it('resolves branches of allOf, anyOf, oneOf and not', () => {
		const doc = makeDoc({
			components: { schemas: { Base: { type: 'object', properties: { id: { type: 'string' } } } } }
		});

		const result = new SchemaResolver(doc).resolve({
			allOf: [{ $ref: '#/components/schemas/Base' }],
			anyOf: [{ $ref: '#/components/schemas/Base' }],
			oneOf: [{ $ref: '#/components/schemas/Base' }],
			not: { $ref: '#/components/schemas/Base' }
		});

		expect(result.allOf[0].properties.id).toEqual({ type: 'string' });
		expect(result.anyOf[0].type).toBe('object');
		expect(result.oneOf[0].type).toBe('object');
		expect(result.not.type).toBe('object');
	});

	it('keeps a 3.1 type array and folds 3.0 nullable into one', () => {
		const resolver = new SchemaResolver(makeDoc());

		expect(resolver.resolve({ type: ['string', 'null'] }).type).toEqual(['string', 'null']);
		expect(resolver.resolve({ type: 'string', nullable: true }).type).toEqual(['string', 'null']);
		expect(resolver.resolve({ type: 'string', nullable: true }).nullable).toBeUndefined();
	});

	it('gives colliding $defs names distinct entries', () => {
		const doc = makeDoc({
			components: {
				schemas: {
					A: { type: 'object', properties: { self: { $ref: '#/components/schemas/A' } } },
					B: { type: 'object', properties: { self: { $ref: '#/components/schemas/B' } } }
				}
			}
		});

		const resolver = new SchemaResolver(doc);
		resolver.resolve({ $ref: '#/components/schemas/A' });
		resolver.resolve({ $ref: '#/components/schemas/B' });

		const defs = resolver.defsBlock() ?? {};
		expect(Object.keys(defs).sort()).toEqual(['A', 'B']);
	});

	it('keeps sibling keywords that sit next to a $ref', () => {
		const doc = makeDoc({ components: { schemas: { S: { type: 'string' } } } });
		const result = new SchemaResolver(doc).resolve({
			$ref: '#/components/schemas/S',
			description: 'the important one'
		});

		expect(result.type).toBe('string');
		expect(result.description).toBe('the important one');
	});

	it('stays finite on a deeply chained reference graph', () => {
		const schemas: Record<string, unknown> = {};
		for (let i = 0; i < 200; i++) {
			schemas[`S${i}`] = {
				type: 'object',
				properties: { next: { $ref: `#/components/schemas/S${(i + 1) % 200}` } }
			};
		}

		const resolver = new SchemaResolver(makeDoc({ components: { schemas: schemas as never } }));
		const result = resolver.resolve({ $ref: '#/components/schemas/S0' });

		expect(JSON.stringify(result).length).toBeLessThan(2_000_000);
	});
});

describe('sanitizeText', () => {
	it('strips control characters but keeps tabs and newlines', () => {
		const input = `a${String.fromCharCode(0)}b${String.fromCharCode(7)}c\td\ne`;
		expect(sanitizeText(input)).toBe('abc\td\ne');
	});

	it('strips ANSI escape sequences', () => {
		const esc = String.fromCharCode(27);
		expect(sanitizeText(`${esc}[31mred${esc}[0m`)).toBe('red');
	});

	it('strips zero-width and bidi override characters used to hide text', () => {
		const hidden = `visible${String.fromCharCode(0x200b)}${String.fromCharCode(0x202e)}reversed`;
		expect(sanitizeText(hidden)).toBe('visiblereversed');
	});

	it('caps length', () => {
		const result = sanitizeText('x'.repeat(5000), 100);
		expect(result.length).toBe(100);
		expect(result.endsWith('...')).toBe(true);
	});

	it('returns an empty string for non-string input', () => {
		expect(sanitizeText(undefined)).toBe('');
		expect(sanitizeText(42)).toBe('');
	});
});
