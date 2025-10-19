import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { createMCP } from './mcp';
import { fetchOpenAPI } from './util';
import * as servers from './servers.json';

const app = new Hono();
app.use(secureHeaders());
app.use(logger());
app.use(cors());

// Metrics tracking
const metrics = {
	requests: 0,
	errors: 0,
	serverCache: new Map<string, number>()
};

// App Implementation

app.get('/', (c) => c.text('👋🏾', 200));

app.get('/metrics', (c) =>
	c.json({
		totalRequests: metrics.requests,
		totalErrors: metrics.errors,
		errorRate: metrics.requests > 0 ? (metrics.errors / metrics.requests) * 100 : 0,
		serverUsage: Object.fromEntries(metrics.serverCache)
	})
);

const serverHandler = async (c: any) => {
	metrics.requests++;
	const startTime = Date.now();

	const { server } = c.req.param();

	const serverUrl = (servers as Record<string, string>)[server] || server;

	// Track server usage
	metrics.serverCache.set(server, (metrics.serverCache.get(server) || 0) + 1);

	// Validate URL format
	if (!serverUrl.startsWith('https://')) {
		metrics.errors++;
		const errorType = serverUrl.startsWith('http://') ? 'Insecure' : 'Invalid';
		console.error(`[${errorType}] Server URL rejected: ${serverUrl}`);
		return c.json({ error: `${errorType} server URL`, server: serverUrl }, 400);
	}

	try {
		// Parse hostname more robustly
		const url = new URL(serverUrl);
		const hostname = url.hostname + url.pathname + url.search;
		const openapi = await fetchOpenAPI(serverUrl);

		// Validate OpenAPI structure
		if (!openapi?.openapi || !openapi?.paths) {
			metrics.errors++;
			console.error(`[Invalid OpenAPI] Document missing required fields: ${serverUrl}`);
			return c.json({ error: 'Invalid OpenAPI document', serverUrl }, 400);
		}

		const mcp = createMCP(hostname, openapi);

		// Create a new request with the path stripped of the server prefix
		const mcpPath = c.req.path.replace(`/${server}`, '');
		const newUrl = new URL(mcpPath || '/', c.req.url);
		const newReq = new Request(newUrl, {
			method: c.req.method,
			headers: c.req.raw.headers,
			body: c.req.raw.body
		});

		const response = await mcp.fetch(newReq, c.env);

		// Log successful request
		const duration = Date.now() - startTime;
		console.log(`[${response.status}] ${c.req.method} /${server}${mcpPath} - ${duration}ms`);

		return response;
	} catch (error) {
		metrics.errors++;
		const duration = Date.now() - startTime;
		console.error(
			`[Error] ${c.req.method} /${server} - ${duration}ms - ${error instanceof Error ? error.message : 'Unknown error'}`
		);
		return c.json(
			{
				error: 'Failed to process server',
				message: error instanceof Error ? error.message : 'Unknown error',
				server
			},
			500
		);
	}
};

// Register handler for both /:server and /:server/* routes
app.all('/:server', serverHandler);
app.all('/:server/*', serverHandler);

export default app;
