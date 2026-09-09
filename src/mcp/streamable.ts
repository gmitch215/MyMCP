import type { JsonRpcError, JsonRpcResponse, ProtocolVersion } from '../types';
import {
	ErrorCode,
	FALLBACK_PROTOCOL,
	JSONRPC_VERSION,
	LATEST_PROTOCOL,
	META_CLIENT_CAPABILITIES,
	META_PROTOCOL_VERSION,
	META_SERVER_INFO,
	SUPPORTED_PROTOCOLS,
	isStatelessEra,
	isSupportedProtocol
} from '../types';
import type { McpContext } from './dispatch';
import { LIST_TTL_MS, capabilities, dispatch } from './dispatch';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface TransportOptions {
	/** enforce the 2026-07-28 requirement that Mcp-Method and Mcp-Name are present */
	strictHeaders?: boolean;
	/** builds the request context once the protocol version is known */
	buildContext: (protocol: ProtocolVersion, clientCapabilities: Record<string, any>) => McpContext;
}

function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...extra }
	});
}

function errorResponse(id: string | number | null, error: JsonRpcError, status: number): Response {
	const body: JsonRpcResponse = { jsonrpc: JSONRPC_VERSION, id, error };
	return jsonResponse(body, status);
}

/**
 * Validates the Origin header to prevent DNS rebinding.
 * A missing Origin is allowed: non-browser clients do not send one.
 */
export function originAllowed(request: Request): boolean {
	const origin = request.headers.get('origin');
	if (!origin) return true;

	let originUrl: URL;
	try {
		originUrl = new URL(origin);
	} catch {
		return false;
	}

	// null origin comes from sandboxed documents and opaque contexts
	if (origin === 'null') return false;

	const host = new URL(request.url).host;
	if (originUrl.host === host) return true;

	// a public deployment is used from many hosts, but never from a private page
	const hostname = originUrl.hostname.toLowerCase();
	if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') return true;

	return originUrl.protocol === 'https:';
}

interface ParsedEnvelope {
	protocol: ProtocolVersion;
	clientCapabilities: Record<string, any>;
}

function readEnvelope(message: Record<string, any>, headerVersion: string | null): ParsedEnvelope {
	const meta = (message?.params?._meta ?? {}) as Record<string, unknown>;
	const declared = meta[META_PROTOCOL_VERSION];

	const version =
		typeof declared === 'string'
			? declared
			: headerVersion || (message?.method === 'initialize' ? undefined : FALLBACK_PROTOCOL);

	const capabilitiesFromMeta = meta[META_CLIENT_CAPABILITIES];
	const capabilitiesFromInit = message?.params?.capabilities;

	const clientCapabilities =
		capabilitiesFromMeta && typeof capabilitiesFromMeta === 'object'
			? (capabilitiesFromMeta as Record<string, any>)
			: capabilitiesFromInit && typeof capabilitiesFromInit === 'object'
				? (capabilitiesFromInit as Record<string, any>)
				: {};

	const requested =
		typeof message?.params?.protocolVersion === 'string' && message.method === 'initialize'
			? message.params.protocolVersion
			: version;

	return {
		protocol: (isSupportedProtocol(requested ?? '')
			? requested
			: LATEST_PROTOCOL) as ProtocolVersion,
		clientCapabilities
	};
}

/** the header mirror of `params.name` or `params.uri`, decoded from the base64 sentinel form */
function decodeHeaderValue(value: string): string {
	const match = value.match(/^=\?base64\?(.*)\?=$/);
	if (!match?.[1]) return value;

	try {
		const binary = atob(match[1].replace(/-/g, '+').replace(/_/g, '/'));
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return new TextDecoder().decode(bytes);
	} catch {
		return value;
	}
}

const NAME_BEARING_METHODS = new Set(['tools/call', 'resources/read', 'prompts/get']);

function validateHeaders(
	request: Request,
	message: Record<string, any>,
	protocol: ProtocolVersion,
	strict: boolean
): JsonRpcError | undefined {
	const headerVersion = request.headers.get('mcp-protocol-version');
	const metaVersion = message?.params?._meta?.[META_PROTOCOL_VERSION];

	if (headerVersion && typeof metaVersion === 'string' && headerVersion !== metaVersion) {
		return {
			code: ErrorCode.HeaderMismatch,
			message: `Header mismatch: MCP-Protocol-Version header '${headerVersion}' does not match body value '${metaVersion}'`
		};
	}

	const headerMethod = request.headers.get('mcp-method');
	if (headerMethod && headerMethod !== message?.method) {
		return {
			code: ErrorCode.HeaderMismatch,
			message: `Header mismatch: Mcp-Method header '${headerMethod}' does not match body value '${String(message?.method)}'`
		};
	}

	const expectedName = message?.params?.name ?? message?.params?.uri;
	const headerName = request.headers.get('mcp-name');
	if (headerName && typeof expectedName === 'string') {
		if (decodeHeaderValue(headerName) !== expectedName) {
			return {
				code: ErrorCode.HeaderMismatch,
				message: `Header mismatch: Mcp-Name header does not match body value '${expectedName}'`
			};
		}
	}

	if (!strict || !isStatelessEra(protocol)) return undefined;

	if (!headerMethod) {
		return { code: ErrorCode.HeaderMismatch, message: 'Missing required header: Mcp-Method' };
	}
	if (NAME_BEARING_METHODS.has(String(message?.method)) && !headerName) {
		return { code: ErrorCode.HeaderMismatch, message: 'Missing required header: Mcp-Name' };
	}
	return undefined;
}

function decorate(
	result: Record<string, unknown>,
	protocol: ProtocolVersion,
	ctx: McpContext,
	cacheable: boolean
): Record<string, unknown> {
	if (!isStatelessEra(protocol)) return result;

	const decorated: Record<string, unknown> = { ...result };
	decorated.resultType = (result.resultType as string) ?? 'complete';

	const meta = (decorated._meta ?? {}) as Record<string, unknown>;
	decorated._meta = { ...meta, [META_SERVER_INFO]: ctx.table.serverInfo };

	if (cacheable) {
		decorated.ttlMs = decorated.ttlMs ?? LIST_TTL_MS;
		decorated.cacheScope = decorated.cacheScope ?? 'public';
	}
	return decorated;
}

async function handleMessage(
	request: Request,
	message: Record<string, any>,
	options: TransportOptions
): Promise<{ response?: JsonRpcResponse; status?: number }> {
	if (message?.jsonrpc !== JSONRPC_VERSION || typeof message?.method !== 'string') {
		return {
			response: {
				jsonrpc: JSONRPC_VERSION,
				id: message?.id ?? null,
				error: { code: ErrorCode.InvalidRequest, message: 'Invalid JSON-RPC request' }
			},
			status: 400
		};
	}

	const headerVersion = request.headers.get('mcp-protocol-version');
	const requested = message?.params?._meta?.[META_PROTOCOL_VERSION] ?? headerVersion;

	if (typeof requested === 'string' && !isSupportedProtocol(requested)) {
		return {
			response: {
				jsonrpc: JSONRPC_VERSION,
				id: message.id ?? null,
				error: {
					code: ErrorCode.UnsupportedProtocolVersion,
					message: `Unsupported protocol version: ${requested}`,
					data: { supported: [...SUPPORTED_PROTOCOLS] }
				}
			},
			status: 400
		};
	}

	const { protocol, clientCapabilities } = readEnvelope(message, headerVersion);

	const headerError = validateHeaders(request, message, protocol, options.strictHeaders !== false);
	if (headerError) {
		return {
			response: { jsonrpc: JSONRPC_VERSION, id: message.id ?? null, error: headerError },
			status: 400
		};
	}

	// notifications get no body; the client is not waiting for one
	const isNotification = !('id' in message) || message.id === undefined;
	if (isNotification) return { status: 202 };

	const ctx = options.buildContext(protocol, clientCapabilities);
	const outcome = await dispatch(message.method, message.params ?? {}, ctx);

	if (outcome.error) {
		return {
			response: { jsonrpc: JSONRPC_VERSION, id: message.id ?? null, error: outcome.error },
			status: outcome.httpStatus ?? 200
		};
	}

	return {
		response: {
			jsonrpc: JSONRPC_VERSION,
			id: message.id ?? null,
			result: decorate(outcome.result ?? {}, protocol, ctx, outcome.cacheable === true)
		},
		status: 200
	};
}

const encoder = new TextEncoder();

function sseEvent(data: unknown): Uint8Array {
	return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

/** long-lived stream for change notifications; the tool set is static, so it only keeps alive */
function subscriptionsStream(
	id: string | number | null,
	filter: Record<string, unknown>
): Response {
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(
				sseEvent({
					jsonrpc: JSONRPC_VERSION,
					method: 'notifications/subscriptions/acknowledged',
					params: {
						subscriptionId: crypto.randomUUID(),
						...(filter && typeof filter === 'object' ? { accepted: Object.keys(filter) } : {})
					}
				})
			);
			controller.enqueue(
				sseEvent({ jsonrpc: JSONRPC_VERSION, id, result: { resultType: 'complete' } })
			);
		},
		cancel() {
			// the client closing the stream is the only termination signal we need
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no'
		}
	});
}

/** Handles a POST to the MCP endpoint under the Streamable HTTP transport. */
export async function handleStreamableHttp(
	request: Request,
	options: TransportOptions
): Promise<Response> {
	if (!originAllowed(request)) {
		return errorResponse(
			null,
			{ code: ErrorCode.InvalidRequest, message: 'Origin not allowed' },
			403
		);
	}

	if (request.method === 'GET' || request.method === 'DELETE') {
		return jsonResponse(
			{
				jsonrpc: JSONRPC_VERSION,
				id: null,
				error: {
					code: ErrorCode.InvalidRequest,
					message:
						'This endpoint accepts POST only. Sessions and the standalone GET stream were removed in 2026-07-28.'
				}
			},
			405,
			{ Allow: 'POST, OPTIONS' }
		);
	}

	if (request.method !== 'POST') {
		return jsonResponse({ error: 'Method not allowed' }, 405, { Allow: 'POST, OPTIONS' });
	}

	const raw = await request.text();
	if (raw.length > MAX_BODY_BYTES) {
		return errorResponse(
			null,
			{ code: ErrorCode.InvalidRequest, message: 'Request body too large' },
			413
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return errorResponse(null, { code: ErrorCode.ParseError, message: 'Parse error' }, 400);
	}

	// batching was removed in 2025-06-18 but older clients may still send an array
	if (Array.isArray(parsed)) {
		const responses: JsonRpcResponse[] = [];
		for (const message of parsed) {
			const outcome = await handleMessage(request, message as Record<string, any>, options);
			if (outcome.response) responses.push(outcome.response);
		}
		if (responses.length === 0) return new Response(null, { status: 202 });
		return jsonResponse(responses);
	}

	const message = parsed as Record<string, any>;

	if (message?.method === 'subscriptions/listen') {
		if (!originAllowed(request)) {
			return errorResponse(
				null,
				{ code: ErrorCode.InvalidRequest, message: 'Origin not allowed' },
				403
			);
		}
		return subscriptionsStream(message.id ?? null, message?.params?.notifications ?? {});
	}

	const outcome = await handleMessage(request, message, options);
	if (!outcome.response) return new Response(null, { status: outcome.status ?? 202 });

	return jsonResponse(outcome.response, outcome.status ?? 200);
}

export { capabilities, decorate };
