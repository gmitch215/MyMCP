import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	NetworkPolicyError,
	ResponseTooLargeError,
	assertSafeUrl,
	readCapped,
	safeFetch
} from '../../src/net';

afterEach(() => vi.unstubAllGlobals());

describe('assertSafeUrl', () => {
	it('accepts a public https URL', () => {
		expect(assertSafeUrl('https://api.example.com/openapi.json').host).toBe('api.example.com');
	});

	it('rejects plain http', () => {
		expect(() => assertSafeUrl('http://api.example.com')).toThrow(NetworkPolicyError);
	});

	it('rejects non-http schemes', () => {
		expect(() => assertSafeUrl('file:///etc/passwd')).toThrow(NetworkPolicyError);
		expect(() => assertSafeUrl('gopher://x')).toThrow(NetworkPolicyError);
	});

	it('rejects a malformed URL', () => {
		expect(() => assertSafeUrl('not a url')).toThrow(NetworkPolicyError);
	});

	it.each([
		['https://localhost/x', 'localhost'],
		['https://foo.localhost/x', 'localhost suffix'],
		['https://service.internal/x', 'internal suffix'],
		['https://printer.local/x', 'local suffix'],
		['https://metadata.google.internal/x', 'gcp metadata name']
	])('rejects %s (%s)', (url) => {
		expect(() => assertSafeUrl(url)).toThrow(NetworkPolicyError);
	});

	it.each([
		['https://127.0.0.1/x', 'loopback'],
		['https://10.0.0.5/x', 'RFC1918 10/8'],
		['https://172.16.0.1/x', 'RFC1918 172.16/12'],
		['https://172.31.255.254/x', 'RFC1918 172.31'],
		['https://192.168.1.1/x', 'RFC1918 192.168/16'],
		['https://169.254.169.254/latest/meta-data', 'cloud metadata'],
		['https://0.0.0.0/x', 'this network'],
		['https://100.64.0.1/x', 'CGNAT'],
		['https://198.18.0.1/x', 'benchmarking'],
		['https://224.0.0.1/x', 'multicast'],
		['https://255.255.255.255/x', 'broadcast']
	])('rejects %s (%s)', (url) => {
		expect(() => assertSafeUrl(url)).toThrow(NetworkPolicyError);
	});

	it('allows a public IPv4 literal', () => {
		expect(() => assertSafeUrl('https://8.8.8.8/x')).not.toThrow();
		expect(() => assertSafeUrl('https://172.32.0.1/x')).not.toThrow();
	});

	it.each([
		['https://[::1]/x', 'IPv6 loopback'],
		['https://[fc00::1]/x', 'unique local'],
		['https://[fe80::1]/x', 'link-local'],
		['https://[::ffff:127.0.0.1]/x', 'IPv4-mapped loopback'],
		['https://[::ffff:169.254.169.254]/x', 'IPv4-mapped metadata']
	])('rejects %s (%s)', (url) => {
		expect(() => assertSafeUrl(url)).toThrow(NetworkPolicyError);
	});
});

describe('safeFetch', () => {
	it('blocks a redirect that lands on a private address', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(null, { status: 302, headers: { Location: 'https://169.254.169.254/' } })
			)
		);

		await expect(safeFetch('https://api.example.com/spec')).rejects.toThrow(NetworkPolicyError);
	});

	it('drops credential headers when a redirect leaves the origin', async () => {
		const seen: Record<string, string>[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, init: RequestInit) => {
				const headers: Record<string, string> = {};
				new Headers(init.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
				seen.push(headers);

				if (seen.length === 1) {
					return new Response(null, {
						status: 302,
						headers: { Location: 'https://other.example.com/x' }
					});
				}
				return new Response('ok', { status: 200 });
			})
		);

		await safeFetch('https://api.example.com/x', {
			headers: { Authorization: 'Bearer secret', Cookie: 'a=b' }
		});

		expect(seen[0]!.authorization).toBe('Bearer secret');
		expect(seen[1]!.authorization).toBeUndefined();
		expect(seen[1]!.cookie).toBeUndefined();
	});

	it('never sends credentials to a host outside the allowed set', async () => {
		const seen: Record<string, string>[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, init: RequestInit) => {
				const headers: Record<string, string> = {};
				new Headers(init.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
				seen.push(headers);
				return new Response('ok');
			})
		);

		await safeFetch(
			'https://evil.example.com/x',
			{ headers: { Authorization: 'Bearer secret' } },
			{ credentialHosts: new Set(['api.example.com']) }
		);

		expect(seen[0]!.authorization).toBeUndefined();
	});

	it('downgrades a 303 redirect to GET and drops the body', async () => {
		const methods: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, init: RequestInit) => {
				methods.push(init.method ?? 'GET');
				if (methods.length === 1) {
					return new Response(null, {
						status: 303,
						headers: { Location: 'https://api.example.com/done' }
					});
				}
				return new Response('ok');
			})
		);

		await safeFetch('https://api.example.com/start', { method: 'POST', body: 'x' });
		expect(methods).toEqual(['POST', 'GET']);
	});

	it('gives up after too many redirects', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(null, { status: 302, headers: { Location: 'https://api.example.com/loop' } })
			)
		);

		await expect(
			safeFetch('https://api.example.com/loop', {}, { maxRedirects: 2 })
		).rejects.toThrow(/redirects/);
	});
});

describe('readCapped', () => {
	it('reads a body under the limit', async () => {
		const bytes = await readCapped(new Response('hello'), 1000);
		expect(new TextDecoder().decode(bytes)).toBe('hello');
	});

	it('refuses a body past the limit', async () => {
		await expect(readCapped(new Response('x'.repeat(5000)), 100)).rejects.toThrow(
			ResponseTooLargeError
		);
	});

	it('refuses on a declared content-length past the limit without reading', async () => {
		const response = new Response('short', { headers: { 'Content-Length': '999999' } });
		await expect(readCapped(response, 100)).rejects.toThrow(ResponseTooLargeError);
	});

	it('handles an empty body', async () => {
		const bytes = await readCapped(new Response(null, { status: 204 }), 100);
		expect(bytes.byteLength).toBe(0);
	});
});
