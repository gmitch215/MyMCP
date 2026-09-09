import { describe, expect, it } from 'vitest';
import {
	extractSpecUrls,
	looksLikeHtml,
	serviceDescLinks,
	wellKnownCandidates
} from '../../src/discover';
import { REDOC_PAGE, SCALAR_PAGE, STOPLIGHT_PAGE, SWAGGER_UI_PAGE } from '../helpers';

describe('extractSpecUrls', () => {
	it('finds the description a Scalar page points at', () => {
		const urls = extractSpecUrls(SCALAR_PAGE, 'https://api.tabroom.com/');
		expect(urls).toContain('https://api.tabroom.com/v1');
	});

	it('ignores the Scalar bundle on the CDN', () => {
		const urls = extractSpecUrls(SCALAR_PAGE, 'https://api.tabroom.com/');
		expect(urls.some((u) => u.includes('jsdelivr'))).toBe(false);
	});

	it('finds the description a Swagger UI page points at', () => {
		const urls = extractSpecUrls(SWAGGER_UI_PAGE, 'https://api.example.com/docs');
		expect(urls).toContain('https://api.example.com/static/openapi.json');
	});

	it('finds a Redoc spec-url', () => {
		const urls = extractSpecUrls(REDOC_PAGE, 'https://docs.example.com/');
		expect(urls).toContain('https://docs.example.com/spec/openapi.yaml');
	});

	it('finds a Stoplight Elements apiDescriptionUrl', () => {
		const urls = extractSpecUrls(STOPLIGHT_PAGE, 'https://docs.example.com/');
		expect(urls).toContain('https://docs.example.com/openapi/v2.json');
	});

	it('finds a RapiDoc spec-url', () => {
		const html = '<rapi-doc spec-url="/api/spec.yaml"></rapi-doc>';
		expect(extractSpecUrls(html, 'https://x.example/')).toContain(
			'https://x.example/api/spec.yaml'
		);
	});

	it('finds an RFC 8631 service-desc link in the markup', () => {
		const html = '<link rel="service-desc" href="/openapi.json">';
		expect(extractSpecUrls(html, 'https://x.example/docs')).toContain(
			'https://x.example/openapi.json'
		);
	});

	it('skips asset URLs', () => {
		const html = '<script>var config = { url: "/bundle.js" }</script>';
		expect(extractSpecUrls(html, 'https://x.example/')).toEqual([]);
	});

	it('returns nothing for a page with no description', () => {
		expect(extractSpecUrls('<html><body>hello</body></html>', 'https://x.example/')).toEqual([]);
	});

	it('deduplicates repeated candidates', () => {
		const html = '<script>var a={url:"/spec.json"};var b={url:"/spec.json"}</script>';
		expect(extractSpecUrls(html, 'https://x.example/')).toEqual(['https://x.example/spec.json']);
	});

	it('resolves relative candidates against the page URL', () => {
		const html = '<script>var c = { url: "openapi.json" }</script>';
		expect(extractSpecUrls(html, 'https://x.example/docs/index.html')).toContain(
			'https://x.example/docs/openapi.json'
		);
	});
});

describe('serviceDescLinks', () => {
	it('reads a service-desc Link header', () => {
		const headers = new Headers({ Link: '</openapi.json>; rel="service-desc"' });
		expect(serviceDescLinks(headers, 'https://x.example/docs')).toEqual([
			'https://x.example/openapi.json'
		]);
	});

	it('ignores links with a different relation', () => {
		const headers = new Headers({ Link: '</style.css>; rel="stylesheet"' });
		expect(serviceDescLinks(headers, 'https://x.example/')).toEqual([]);
	});

	it('returns nothing when the header is absent', () => {
		expect(serviceDescLinks(new Headers(), 'https://x.example/')).toEqual([]);
	});
});

describe('wellKnownCandidates', () => {
	it('builds absolute candidates from the origin', () => {
		const urls = wellKnownCandidates('https://api.example.com/docs/page');
		expect(urls).toContain('https://api.example.com/openapi.json');
		expect(urls).toContain('https://api.example.com/v3/api-docs');
	});
});

describe('looksLikeHtml', () => {
	it('detects HTML by content type or by the leading markup', () => {
		expect(looksLikeHtml('text/html; charset=utf-8', '')).toBe(true);
		expect(looksLikeHtml(null, '<!doctype html><html>')).toBe(true);
		expect(looksLikeHtml('application/json', '{"openapi":"3.1.0"}')).toBe(false);
	});
});
