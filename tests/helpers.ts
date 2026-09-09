import { vi } from 'vitest';
import type { OpenAPI } from '../src/types';

export function makeDoc(partial: Partial<OpenAPI> = {}): OpenAPI {
	return {
		openapi: '3.1.0',
		info: { title: 'Test API', description: 'A test API', version: '1.0.0' },
		servers: [{ url: 'https://api.test.example' }],
		paths: {},
		...partial
	} as OpenAPI;
}

export interface StubRoute {
	status?: number;
	headers?: Record<string, string>;
	body?: string;
	/** when set, the stub throws instead of responding */
	error?: Error;
}

export interface RecordedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
}

export interface FetchStub {
	requests: RecordedRequest[];
	restore(): void;
}

/**
 * Replaces global fetch with a table-driven stub.
 * Keys are matched by exact URL first, then by substring, so tests stay readable.
 */
export function stubFetch(routes: Record<string, StubRoute>): FetchStub {
	const requests: RecordedRequest[] = [];

	const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url =
			typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		const method = (
			init?.method ?? (input instanceof Request ? input.method : 'GET')
		).toUpperCase();

		const headers: Record<string, string> = {};
		new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach(
			(value, key) => {
				headers[key.toLowerCase()] = value;
			}
		);

		let body: string | undefined;
		if (typeof init?.body === 'string') body = init.body;
		else if (init?.body instanceof URLSearchParams) body = init.body.toString();

		requests.push({ url, method, headers, body });

		const route = routes[url] ?? Object.entries(routes).find(([key]) => url.includes(key))?.[1];

		if (!route) {
			return new Response(JSON.stringify({ error: 'no stub', url }), {
				status: 404,
				headers: { 'Content-Type': 'application/json' }
			});
		}
		if (route.error) throw route.error;

		const status = route.status ?? 200;
		const nullBody = status === 204 || status === 205 || status === 304;

		return new Response(nullBody ? null : (route.body ?? ''), {
			status,
			headers: { 'Content-Type': 'application/json', ...route.headers }
		});
	};

	vi.stubGlobal('fetch', vi.fn(impl));

	return {
		requests,
		restore() {
			vi.unstubAllGlobals();
		}
	};
}

/** the real shape of the Scalar page served at api.tabroom.com, trimmed */
export const SCALAR_PAGE = `<!doctype html>
<html>
  <head><title>Scalar API Reference</title></head>
  <body>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
    <script type="text/javascript">
      Scalar.createApiReference('#app', {
        "_integration": "express",
        "url": "/v1",
        "orderSchemaPropertiesBy": "preserve",
        "persistAuth": true,
        "showOperationId": true,
        "metaData": { "title": "Tabroom.com API Reference" }
      })
    </script>
  </body>
</html>`;

export const SWAGGER_UI_PAGE = `<!doctype html>
<html><body><div id="swagger-ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist/swagger-ui-bundle.js"></script>
<script>
window.ui = SwaggerUIBundle({ url: "/static/openapi.json", dom_id: '#swagger-ui' });
</script></body></html>`;

export const REDOC_PAGE = `<!doctype html><html><body>
<redoc spec-url="https://docs.example.com/spec/openapi.yaml"></redoc>
<script src="https://cdn.jsdelivr.net/npm/redoc/bundles/redoc.standalone.js"></script>
</body></html>`;

export const STOPLIGHT_PAGE = `<!doctype html><html><body>
<elements-api apiDescriptionUrl="/openapi/v2.json" router="hash"></elements-api>
</body></html>`;

/** builds a JSON-RPC request body for the current protocol era */
export function rpc(
	method: string,
	params: Record<string, unknown> = {},
	id: string | number | null = 1,
	protocolVersion = '2026-07-28'
): string {
	return JSON.stringify({
		jsonrpc: '2.0',
		...(id === null ? { id: null } : { id }),
		method,
		params: {
			...params,
			_meta: {
				'io.modelcontextprotocol/protocolVersion': protocolVersion,
				'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
				'io.modelcontextprotocol/clientCapabilities': {}
			}
		}
	});
}

export function mcpHeaders(
	method: string,
	name?: string,
	protocolVersion = '2026-07-28'
): Record<string, string> {
	return {
		'Content-Type': 'application/json',
		Accept: 'application/json, text/event-stream',
		'MCP-Protocol-Version': protocolVersion,
		'Mcp-Method': method,
		...(name ? { 'Mcp-Name': name } : {})
	};
}
