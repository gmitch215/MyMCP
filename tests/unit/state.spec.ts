import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env';
import { fromBase64Url, requestDigest, seal, toBase64Url, unseal } from '../../src/state';

const env: Env = { STATE_SECRET: 'a-secret-used-only-in-tests' };
const other: Env = { STATE_SECRET: 'a-completely-different-secret' };

describe('base64url', () => {
	it('round-trips arbitrary bytes', () => {
		const bytes = new Uint8Array([0, 1, 250, 255, 128, 64]);
		expect([...fromBase64Url(toBase64Url(bytes))]).toEqual([...bytes]);
	});

	it('produces url-safe output', () => {
		const encoded = toBase64Url(new Uint8Array([251, 255, 190]));
		expect(encoded).not.toMatch(/[+/=]/);
	});
});

describe('seal and unseal', () => {
	it('round-trips a payload', async () => {
		const token = await seal(env, { tool: 'listPets', args: { a: 1 } }, 60_000);
		expect(await unseal(env, token)).toEqual({ tool: 'listPets', args: { a: 1 } });
	});

	it('rejects a payload sealed with a different secret', async () => {
		const token = await seal(env, { x: 1 }, 60_000);
		expect(await unseal(other, token)).toBeNull();
	});

	it('rejects tampered state', async () => {
		const token = await seal(env, { x: 1 }, 60_000);
		const tampered = `${token.slice(0, -4)}AAAA`;
		expect(await unseal(env, tampered)).toBeNull();
	});

	it('rejects expired state', async () => {
		const token = await seal(env, { x: 1 }, -1000);
		expect(await unseal(env, token)).toBeNull();
	});

	it('rejects state presented by a different principal', async () => {
		const token = await seal(env, { x: 1 }, 60_000, 'user-a');
		expect(await unseal(env, token, { principal: 'user-b' })).toBeNull();
		expect(await unseal(env, token, { principal: 'user-a' })).toEqual({ x: 1 });
	});

	it('rejects state replayed onto a different request', async () => {
		const digest = await requestDigest('tools/call', { name: 'listPets' });
		const otherDigest = await requestDigest('tools/call', { name: 'deleteEverything' });
		const token = await seal(env, { x: 1 }, 60_000, undefined, digest);

		expect(await unseal(env, token, { digest: otherDigest })).toBeNull();
		expect(await unseal(env, token, { digest })).toEqual({ x: 1 });
	});

	it('rejects malformed input rather than throwing', async () => {
		expect(await unseal(env, '')).toBeNull();
		expect(await unseal(env, 'not-base64!!')).toBeNull();
		expect(await unseal(env, 'AAAA')).toBeNull();
	});

	it('produces a different ciphertext each time for the same payload', async () => {
		const a = await seal(env, { x: 1 }, 60_000);
		const b = await seal(env, { x: 1 }, 60_000);
		expect(a).not.toBe(b);
	});
});

describe('requestDigest', () => {
	it('is stable for the same method and params', async () => {
		expect(await requestDigest('tools/call', { name: 'x', a: 1 })).toBe(
			await requestDigest('tools/call', { name: 'x', a: 1 })
		);
	});

	it('ignores key order', async () => {
		expect(await requestDigest('tools/call', { a: 1, b: 2 })).toBe(
			await requestDigest('tools/call', { b: 2, a: 1 })
		);
	});

	it('ignores _meta, which varies per request', async () => {
		expect(await requestDigest('tools/call', { name: 'x', _meta: { a: 1 } })).toBe(
			await requestDigest('tools/call', { name: 'x', _meta: { b: 2 } })
		);
	});

	it('differs for a different method or params', async () => {
		expect(await requestDigest('tools/call', { name: 'x' })).not.toBe(
			await requestDigest('prompts/get', { name: 'x' })
		);
		expect(await requestDigest('tools/call', { name: 'x' })).not.toBe(
			await requestDigest('tools/call', { name: 'y' })
		);
	});
});
