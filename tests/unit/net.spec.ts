import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	NetworkPolicyError,
	ResponseTooLargeError,
	assertSafeUrl,
	readCapped,
	readCappedText,
	safeFetch
} from '../../src/net';

afterEach(() => vi.unstubAllGlobals());

describe('IPv6 and mapped addresses', () => {
	it('allows a public IPv6 address', () => {
		expect(() => assertSafeUrl('https://[2606:4700:4700::1111]/x')).not.toThrow();
	});

	it('blocks an IPv4-mapped private address', () => {
		expect(() => assertSafeUrl('https://[::ffff:10.0.0.1]/x')).toThrow(NetworkPolicyError);
	});

	it('allows an IPv4-mapped public address', () => {
		expect(() => assertSafeUrl('https://[::ffff:8.8.8.8]/x')).not.toThrow();
	});

	it('blocks an IPv4-compatible loopback address', () => {
		expect(() => assertSafeUrl('https://[::127.0.0.1]/x')).toThrow(NetworkPolicyError);
	});

	it('blocks the unspecified and loopback IPv6 addresses', () => {
		expect(() => assertSafeUrl('https://[::]/x')).toThrow(NetworkPolicyError);
		expect(() => assertSafeUrl('https://[::1]/x')).toThrow(NetworkPolicyError);
	});

	it('blocks unique-local and link-local IPv6 addresses', () => {
		expect(() => assertSafeUrl('https://[fd12::1]/x')).toThrow(NetworkPolicyError);
		expect(() => assertSafeUrl('https://[fe80::1]/x')).toThrow(NetworkPolicyError);
	});
});

describe('redirect handling', () => {
	it('asks fetch not to follow redirects, so every hop passes the policy', async () => {
		const seen: RequestInit[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, init: RequestInit) => {
				seen.push(init);
				return new Response('ok');
			})
		);

		await safeFetch('https://api.example.com/x');

		expect(seen[0]?.redirect).toBe('manual');
	});

	it('refuses a redirect into a private address', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(null, {
						status: 302,
						headers: { location: 'https://169.254.169.254/latest/meta-data' }
					})
			)
		);

		await expect(safeFetch('https://api.example.com/x')).rejects.toThrow(NetworkPolicyError);
	});

	it('returns a redirect that has no Location header as-is', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(null, { status: 301 }))
		);

		const response = await safeFetch('https://api.example.com/x');

		expect(response.status).toBe(301);
	});

	it('turns a POST answered with 302 into a GET, and drops credentials on a new origin', async () => {
		const calls: { url: string; method: string; auth: string | null }[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string, init: RequestInit) => {
				calls.push({
					url: String(input),
					method: String(init.method),
					auth: new Headers(init.headers).get('authorization')
				});
				if (calls.length === 1) {
					return new Response(null, {
						status: 302,
						headers: { location: 'https://b.example.com/y' }
					});
				}
				return new Response('ok', { status: 200 });
			})
		);

		const response = await safeFetch(
			'https://a.example.com/x',
			{ method: 'POST', body: 'payload', headers: { Authorization: 'Bearer t' } },
			{}
		);

		expect(response.status).toBe(200);
		expect(calls[1]).toEqual({ url: 'https://b.example.com/y', method: 'GET', auth: null });
	});

	it('stops a request when the caller aborts its signal', async () => {
		const controller = new AbortController();
		vi.stubGlobal(
			'fetch',
			vi.fn(
				(_url: string, init: RequestInit) =>
					new Promise((_resolve, reject) => {
						init.signal?.addEventListener('abort', () => reject(new Error('aborted by caller')));
					})
			)
		);

		const pending = safeFetch('https://api.example.com/x', {}, { signal: controller.signal });
		controller.abort();

		await expect(pending).rejects.toThrow('aborted by caller');
	});
});

describe('readCapped edge cases', () => {
	it('returns no bytes for a response without a body', async () => {
		expect(await readCapped(new Response(null), 10)).toHaveLength(0);
	});

	it('reads a body as text within the limit', async () => {
		expect(await readCappedText(new Response('hello'), 100)).toBe('hello');
	});
});

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
