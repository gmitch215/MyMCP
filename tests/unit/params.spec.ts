import { describe, expect, it } from 'vitest';
import {
	applyPathTemplate,
	joinUrl,
	resolveServerUrl,
	serializeHeaderParam,
	serializePathParam,
	serializeQueryParam
} from '../../src/openapi/params';

describe('serializeQueryParam', () => {
	it('explodes arrays under the default form style', () => {
		expect(serializeQueryParam('id', [3, 4, 5])).toEqual(['id=3', 'id=4', 'id=5']);
	});

	it('joins arrays with a comma when explode is off', () => {
		expect(serializeQueryParam('id', [3, 4, 5], { style: 'form', explode: false })).toEqual([
			'id=3,4,5'
		]);
	});

	it('supports spaceDelimited and pipeDelimited', () => {
		expect(serializeQueryParam('id', [3, 4], { style: 'spaceDelimited', explode: false })).toEqual([
			'id=3%204'
		]);
		expect(serializeQueryParam('id', [3, 4], { style: 'pipeDelimited', explode: false })).toEqual([
			'id=3%7C4'
		]);
	});

	it('serializes deepObject as bracketed keys instead of [object Object]', () => {
		const result = serializeQueryParam('filter', { name: 'x', age: 3 }, { style: 'deepObject' });
		expect(result).toEqual(['filter%5Bname%5D=x', 'filter%5Bage%5D=3']);
		expect(result.join('&')).not.toContain('object+Object');
	});

	it('explodes an object into bare keys under form style', () => {
		expect(serializeQueryParam('f', { a: 1, b: 2 }, { style: 'form', explode: true })).toEqual([
			'a=1',
			'b=2'
		]);
	});

	it('flattens an object to comma pairs when explode is off', () => {
		expect(serializeQueryParam('f', { a: 1, b: 2 }, { style: 'form', explode: false })).toEqual([
			'f=a,1,b,2'
		]);
	});

	it('percent-encodes values and skips undefined', () => {
		expect(serializeQueryParam('q', 'a b&c')).toEqual(['q=a%20b%26c']);
		expect(serializeQueryParam('q', undefined)).toEqual([]);
	});

	it('keeps reserved characters when allowReserved is set', () => {
		expect(serializeQueryParam('path', 'a/b', { allowReserved: true })).toEqual(['path=a/b']);
	});
});

describe('serializePathParam', () => {
	it('encodes a simple value', () => {
		expect(serializePathParam('id', 'a/b')).toBe('a%2Fb');
	});

	it('joins arrays with commas under simple style', () => {
		expect(serializePathParam('id', [3, 4])).toBe('3,4');
	});

	it('prefixes label style with a dot', () => {
		expect(serializePathParam('id', [3, 4], { style: 'label', explode: false })).toBe('.3,4');
		expect(serializePathParam('id', [3, 4], { style: 'label', explode: true })).toBe('.3.4');
	});

	it('emits matrix style with the parameter name', () => {
		expect(serializePathParam('id', [3, 4], { style: 'matrix', explode: false })).toBe(';id=3,4');
		expect(serializePathParam('id', [3, 4], { style: 'matrix', explode: true })).toBe(';id=3;id=4');
	});

	it('serializes an object under simple style with explode', () => {
		expect(serializePathParam('f', { a: 1, b: 2 }, { explode: true })).toBe('a=1,b=2');
		expect(serializePathParam('f', { a: 1, b: 2 }, { explode: false })).toBe('a,1,b,2');
	});
});

describe('applyPathTemplate', () => {
	it('replaces every occurrence of a repeated placeholder', () => {
		const result = applyPathTemplate('/a/{id}/b/{id}', new Map([['id', '42']]));
		expect(result).toBe('/a/42/b/42');
	});

	it('replaces several distinct placeholders', () => {
		const values = new Map([
			['owner', 'octocat'],
			['repo', 'hello']
		]);
		expect(applyPathTemplate('/repos/{owner}/{repo}/commits', values)).toBe(
			'/repos/octocat/hello/commits'
		);
	});

	it('leaves an unsupplied placeholder visible rather than silently blank', () => {
		expect(applyPathTemplate('/a/{missing}', new Map())).toBe('/a/{missing}');
	});
});

describe('resolveServerUrl', () => {
	it('substitutes variables from their defaults', () => {
		const url = resolveServerUrl({
			url: 'https://{region}.api.example/{version}',
			variables: { region: { default: 'us' }, version: { default: 'v2' } }
		});
		expect(url).toBe('https://us.api.example/v2');
	});

	it('prefers an override over the default', () => {
		const url = resolveServerUrl(
			{ url: 'https://{region}.api.example', variables: { region: { default: 'us' } } },
			{ region: 'eu' }
		);
		expect(url).toBe('https://eu.api.example');
	});

	it('falls back to the first enum value when no default is given', () => {
		const url = resolveServerUrl({
			url: 'https://{region}.api.example',
			variables: { region: { enum: ['ap', 'us'] } }
		});
		expect(url).toBe('https://ap.api.example');
	});
});

describe('joinUrl', () => {
	it('does not double or drop the separating slash', () => {
		expect(joinUrl('https://a.example/', '/v1/pets')).toBe('https://a.example/v1/pets');
		expect(joinUrl('https://a.example', 'v1/pets')).toBe('https://a.example/v1/pets');
	});

	it('keeps a matrix segment attached to the base', () => {
		expect(joinUrl('https://a.example', ';id=3')).toBe('https://a.example;id=3');
	});
});

describe('serializeHeaderParam', () => {
	it('joins arrays with commas', () => {
		expect(serializeHeaderParam([1, 2, 3])).toBe('1,2,3');
	});

	it('formats objects as pairs when exploded', () => {
		expect(serializeHeaderParam({ a: 1, b: 2 }, { explode: true })).toBe('a=1,b=2');
		expect(serializeHeaderParam({ a: 1, b: 2 })).toBe('a,1,b,2');
	});
});
