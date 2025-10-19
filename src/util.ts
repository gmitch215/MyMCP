import { OpenAPI, MCPRequest } from './types';

export function toMachineName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
}

/**
 * Normalizes a server path by ensuring it starts and ends with '/'
 */
export function normalizeServerPath(serverId: string): string {
	let serverPath = serverId.split(':')[2];
	if (!serverPath.startsWith('/')) {
		serverPath = `/${serverPath}`;
	}
	if (!serverPath.endsWith('/')) {
		serverPath = `${serverPath}/`;
	}
	return serverPath;
}

/**
 * Extracts and processes parameters from MCP request
 * Returns: { body, queryParameters, pathParameters, headers }
 */
export function processParameters(parameters: Record<string, any>) {
	let body: any = null;
	const parametersCopy = { ...parameters };

	if (parametersCopy.body) {
		body = parametersCopy.body;
		delete parametersCopy.body;
	}

	const queryParameters = new URLSearchParams();
	const pathParameters = new Map<string, string>();
	const headers = new Map<string, string>();

	for (const [key, value] of Object.entries(parametersCopy)) {
		if (key.startsWith('query-')) {
			const paramName = key.substring(6);
			// Handle array values for repeated query parameters
			if (Array.isArray(value)) {
				value.forEach((v) => queryParameters.append(paramName, String(v)));
			} else {
				queryParameters.append(paramName, String(value));
			}
		} else if (key.startsWith('path-')) {
			pathParameters.set(key.substring(5), String(value));
		} else if (key.startsWith('header-')) {
			headers.set(key.substring(7), String(value));
		} else if (key.startsWith('cookie-')) {
			// Add cookies to headers
			const cookieName = key.substring(7);
			const existingCookie = headers.get('Cookie');
			headers.set(
				'Cookie',
				existingCookie ? `${existingCookie}; ${cookieName}=${value}` : `${cookieName}=${value}`
			);
		}
	}

	return { body, queryParameters, pathParameters, headers };
}

/**
 * Builds the final URL for an API call by replacing path parameters
 */
export function buildApiUrl(
	host: string,
	serverPath: string,
	path: string,
	pathParameters: Map<string, string>,
	queryParameters: URLSearchParams
): string {
	const processedPath = Array.from(pathParameters.entries()).reduce((prev, [key, value]) => {
		return prev
			.replace(`{${key}}`, encodeURIComponent(value))
			.replace(`:${key}`, encodeURIComponent(value));
	}, path);

	const baseUrl = `https://${host}${serverPath}${processedPath}`;
	return queryParameters.toString().length > 0
		? `${baseUrl}?${queryParameters.toString()}`
		: baseUrl;
}

/**
 * Executes an API call based on MCP invocation parameters
 */
export async function executeApiCall(
	host: string,
	serverPath: string,
	method: string,
	path: string,
	parameters: Record<string, any>,
	contentType: string = 'application/json',
	securitySchemes?: Record<string, any>
): Promise<any> {
	const { body, queryParameters, pathParameters, headers } = processParameters(parameters);
	const url = buildApiUrl(host, serverPath, path, pathParameters, queryParameters);

	const requestHeaders: Record<string, string> = {
		'Content-Type': contentType
	};

	// Add custom headers
	headers.forEach((value, key) => {
		requestHeaders[key] = value;
	});

	// Handle authentication
	if (securitySchemes) {
		for (const [schemeName, scheme] of Object.entries(securitySchemes)) {
			if (scheme.type === 'apiKey' && scheme.in === 'header' && scheme.name) {
				// API key would be passed as a parameter
				const apiKeyParam = `header-${scheme.name}`;
				if (parameters[apiKeyParam]) {
					requestHeaders[scheme.name] = String(parameters[apiKeyParam]);
				}
			} else if (scheme.type === 'http' && scheme.scheme === 'bearer') {
				if (parameters['authorization'] || parameters['header-Authorization']) {
					requestHeaders['Authorization'] = String(
						parameters['authorization'] || parameters['header-Authorization']
					);
				}
			}
		}
	}

	const requestOptions: RequestInit = {
		method,
		headers: requestHeaders
	};

	// Only add body for methods that support it
	if (body && !['GET', 'HEAD'].includes(method.toUpperCase())) {
		requestOptions.body = contentType === 'application/json' ? JSON.stringify(body) : body;
	}

	const response = await fetch(url, requestOptions);

	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(
			`API call failed: ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody}` : ''}`
		);
	}

	// Handle different response content types
	const responseContentType = response.headers.get('content-type');
	if (responseContentType?.includes('application/json')) {
		return response.json();
	} else {
		return response.text();
	}
}

export async function fetchOpenAPI(server: string): Promise<OpenAPI> {
	const cache = await caches.open('openapi-cache');
	const cacheKey = new Request(server);

	// Try to get from cache
	let response = await cache.match(cacheKey);
	if (!response) {
		response = await fetch(server);
		if (!response.ok) {
			throw new Error(`Failed to fetch OpenAPI document: ${response.status}`);
		}

		const responseToCache = response.clone();
		const headers = new Headers(responseToCache.headers);
		headers.set('Cache-Control', 'public, max-age=3600');
		const cachedResponse = new Response(responseToCache.body, {
			status: responseToCache.status,
			statusText: responseToCache.statusText,
			headers
		});

		await cache.put(cacheKey, cachedResponse);
	}

	return response.json<OpenAPI>();
}
