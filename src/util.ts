import { OpenAPI, MCPRequest, isValidOpenAPI } from './types';

export function toMachineName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
}

export function processParameters(parameters: Record<string, any>) {
	if (!parameters || typeof parameters !== 'object') {
		return {
			body: null,
			queryParameters: new URLSearchParams(),
			pathParameters: new Map<string, string>(),
			headers: new Map<string, string>()
		};
	}

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
		if (!key || value === undefined || value === null) continue;

		if (key.startsWith('query-')) {
			const paramName = key.substring(6);
			if (!paramName) continue;
			// Handle array values for repeated query parameters
			if (Array.isArray(value)) {
				value.forEach((v) => {
					if (v !== undefined && v !== null) {
						queryParameters.append(paramName, String(v));
					}
				});
			} else {
				queryParameters.append(paramName, String(value));
			}
		} else if (key.startsWith('path-')) {
			const paramName = key.substring(5);
			if (paramName) {
				pathParameters.set(paramName, String(value));
			}
		} else if (key.startsWith('header-')) {
			const headerName = key.substring(7);
			if (headerName) {
				headers.set(headerName, String(value));
			}
		} else if (key.startsWith('cookie-')) {
			// Add cookies to headers
			const cookieName = key.substring(7);
			if (cookieName) {
				const existingCookie = headers.get('Cookie');
				headers.set(
					'Cookie',
					existingCookie ? `${existingCookie}; ${cookieName}=${value}` : `${cookieName}=${value}`
				);
			}
		}
	}

	return { body, queryParameters, pathParameters, headers };
}

export function buildApiUrl(
	host: string,
	path: string,
	pathParameters: Map<string, string>,
	queryParameters: URLSearchParams
): string {
	if (!host || typeof host !== 'string') {
		throw new Error('Host must be a non-empty string');
	}

	if (!path || typeof path !== 'string') {
		throw new Error('Path must be a non-empty string');
	}

	const processedPath = Array.from(pathParameters.entries()).reduce((prev, [key, value]) => {
		if (!key) return prev;
		return prev
			.replace(`{${key}}`, encodeURIComponent(value))
			.replace(`:${key}`, encodeURIComponent(value));
	}, path);

	// Normalize the URL construction to avoid double slashes and path duplication
	let baseUrl: string;
	if (host.startsWith('http')) {
		// Remove trailing slash from host
		const normalizedHost = host.endsWith('/') ? host.slice(0, -1) : host;
		// Ensure path starts with slash
		const normalizedPath = processedPath.startsWith('/') ? processedPath : `/${processedPath}`;
		baseUrl = `${normalizedHost}${normalizedPath}`;
	} else {
		const normalizedHost = host.endsWith('/') ? host.slice(0, -1) : host;
		const normalizedPath = processedPath.startsWith('/') ? processedPath : `/${processedPath}`;
		baseUrl = `https://${normalizedHost}${normalizedPath}`;
	}

	const queryString = queryParameters.toString();
	return queryString.length > 0 ? `${baseUrl}?${queryString}` : baseUrl;
}

export async function executeApiCall(
	host: string,
	method: string,
	path: string,
	parameters: Record<string, any>,
	contentType: string = 'application/json',
	securitySchemes?: Record<string, any>
): Promise<any> {
	if (!host || typeof host !== 'string') {
		throw new Error('Host must be a non-empty string');
	}

	if (!method || typeof method !== 'string') {
		throw new Error('Method must be a non-empty string');
	}

	if (!path || typeof path !== 'string') {
		throw new Error('Path must be a non-empty string');
	}

	const { body, queryParameters, pathParameters, headers } = processParameters(parameters || {});
	const url = buildApiUrl(host, path, pathParameters, queryParameters);

	console.log(`[API Call] ${method} ${url}`);
	console.log(`[API Call] Parameters:`, parameters);

	const requestHeaders: Record<string, string> = {
		'Content-Type': contentType
	};

	// Add custom headers
	headers.forEach((value, key) => {
		if (key && value) {
			requestHeaders[key] = value;
		}
	});

	// Handle authentication
	if (securitySchemes && typeof securitySchemes === 'object') {
		for (const [, scheme] of Object.entries(securitySchemes)) {
			if (!scheme || typeof scheme !== 'object') continue;

			if (scheme.type === 'apiKey' && scheme.in === 'header' && scheme.name) {
				// API key would be passed as a parameter
				const apiKeyParam = `header-${scheme.name}`;
				if (parameters && parameters[apiKeyParam]) {
					requestHeaders[scheme.name] = String(parameters[apiKeyParam]);
				}
			} else if (scheme.type === 'http' && scheme.scheme === 'bearer') {
				if (parameters && (parameters['authorization'] || parameters['header-Authorization'])) {
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
		const errorMsg = `API call failed: ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody}` : ''}`;
		console.error(`[API Call Error] ${errorMsg}`);
		throw new Error(errorMsg);
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
	if (!server || typeof server !== 'string') {
		throw new Error('Server URL must be a non-empty string');
	}

	const cache = await caches.open('openapi-cache');
	const cacheKey = new Request(server);

	// Try to get from cache
	let response = await cache.match(cacheKey);
	if (!response) {
		response = await fetch(server);
		if (!response.ok) {
			throw new Error(
				`Failed to fetch OpenAPI document: ${response.status} ${response.statusText}`
			);
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

	const json = await response.json();

	// Validate the parsed JSON conforms to OpenAPI structure
	if (!isValidOpenAPI(json)) {
		throw new Error(
			'Invalid OpenAPI document: missing required fields (openapi, servers, info.title, info.description, or paths)'
		);
	}

	return json;
}
