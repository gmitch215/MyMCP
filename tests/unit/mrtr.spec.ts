import { describe, expect, it } from 'vitest';
import {
	buildElicitationSchema,
	confirmationSchema,
	formElicitation,
	readElicitResult,
	supportsElicitation,
	supportsExtension,
	urlElicitation
} from '../../src/mcp/mrtr';
import { buildToolTable } from '../../src/openapi/tools';
import { TASKS_EXTENSION } from '../../src/types';
import { makeDoc } from '../helpers';

const table = buildToolTable(
	makeDoc({
		paths: {
			'/search': {
				get: {
					operationId: 'search',
					parameters: [
						{
							name: 'q',
							in: 'query',
							required: true,
							schema: { type: 'string', description: 'query' }
						},
						{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 } },
						{ name: 'status', in: 'query', schema: { type: 'string', enum: ['open', 'closed'] } },
						{ name: 'email', in: 'query', schema: { type: 'string', format: 'email' } },
						{ name: 'filter', in: 'query', schema: { type: 'object' } }
					],
					responses: {}
				}
			}
		}
	})
);

const tool = table.byName.get('search')!;

describe('supportsElicitation', () => {
	it('treats an empty elicitation object as form support only', () => {
		expect(supportsElicitation({ elicitation: {} }, 'form')).toBe(true);
		expect(supportsElicitation({ elicitation: {} }, 'url')).toBe(false);
	});

	it('reads explicit mode declarations', () => {
		expect(supportsElicitation({ elicitation: { url: {} } }, 'url')).toBe(true);
		expect(supportsElicitation({ elicitation: { url: {} } }, 'form')).toBe(false);
		expect(supportsElicitation({ elicitation: { form: {}, url: {} } }, 'form')).toBe(true);
	});

	it('returns false when the client declared nothing', () => {
		expect(supportsElicitation({}, 'form')).toBe(false);
		expect(supportsElicitation(undefined, 'form')).toBe(false);
	});
});

describe('supportsExtension', () => {
	it('detects a declared extension', () => {
		expect(supportsExtension({ extensions: { [TASKS_EXTENSION]: {} } }, TASKS_EXTENSION)).toBe(
			true
		);
		expect(supportsExtension({ extensions: {} }, TASKS_EXTENSION)).toBe(false);
		expect(supportsExtension(undefined, TASKS_EXTENSION)).toBe(false);
	});
});

describe('buildElicitationSchema', () => {
	it('builds a flat schema for primitive arguments', () => {
		const schema = buildElicitationSchema(tool, ['q', 'limit'])!;

		expect(schema.type).toBe('object');
		expect(schema.properties.q.type).toBe('string');
		expect(schema.properties.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 50 });
		expect(schema.required).toEqual(['q', 'limit']);
	});

	it('represents an enum as a string with choices', () => {
		const schema = buildElicitationSchema(tool, ['status'])!;
		expect(schema.properties.status.enum).toEqual(['open', 'closed']);
	});

	it('keeps a supported string format', () => {
		expect(buildElicitationSchema(tool, ['email'])!.properties.email.format).toBe('email');
	});

	it('skips arguments with no form representation', () => {
		expect(buildElicitationSchema(tool, ['filter'])).toBeUndefined();
	});

	it('returns undefined when nothing can be represented', () => {
		expect(buildElicitationSchema(tool, ['nosuchargument'])).toBeUndefined();
	});
});

describe('elicitation requests', () => {
	it('builds a form request', () => {
		const request = formElicitation('please', { type: 'object', properties: {} });
		expect(request.method).toBe('elicitation/create');
		expect(request.params.mode).toBe('form');
		expect(request.params.message).toBe('please');
	});

	it('builds a url request', () => {
		const request = urlElicitation('sign in', 'https://example.com/connect');
		expect(request.params.mode).toBe('url');
		expect(request.params.url).toBe('https://example.com/connect');
	});

	it('builds a confirmation schema with a boolean', () => {
		const schema = confirmationSchema('Run DELETE /pets/1');
		expect(schema.properties.confirm.type).toBe('boolean');
		expect(schema.required).toEqual(['confirm']);
	});
});

describe('readElicitResult', () => {
	it('reads each action', () => {
		expect(readElicitResult({ action: 'accept', content: { a: 1 } })).toEqual({
			action: 'accept',
			content: { a: 1 }
		});
		expect(readElicitResult({ action: 'decline' })?.action).toBe('decline');
		expect(readElicitResult({ action: 'cancel' })?.action).toBe('cancel');
	});

	it('rejects anything that is not a valid result', () => {
		expect(readElicitResult(undefined)).toBeUndefined();
		expect(readElicitResult({ action: 'sideways' })).toBeUndefined();
		expect(readElicitResult('accept')).toBeUndefined();
	});
});
