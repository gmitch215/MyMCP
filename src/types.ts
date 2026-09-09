export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/** a JSON Schema node; deliberately loose since real specs carry arbitrary keywords */
export type JsonSchema = Record<string, any>;

// #region OpenAPI

export type OpenAPIMethod =
	'get' | 'post' | 'put' | 'delete' | 'patch' | 'options' | 'head' | 'trace';

export const HTTP_METHODS: readonly OpenAPIMethod[] = [
	'get',
	'post',
	'put',
	'delete',
	'patch',
	'options',
	'head',
	'trace'
];

export type ParameterLocation = 'query' | 'header' | 'path' | 'cookie';

export interface OpenAPIParameter {
	name: string;
	in: ParameterLocation;
	description?: string;
	required?: boolean;
	deprecated?: boolean;
	style?: string;
	explode?: boolean;
	allowReserved?: boolean;
	schema?: JsonSchema;
	content?: Record<string, { schema?: JsonSchema }>;
	$ref?: string;
}

export interface OpenAPIMediaType {
	schema?: JsonSchema;
	encoding?: Record<string, { contentType?: string; style?: string; explode?: boolean }>;
}

export interface OpenAPIRequestBody {
	description?: string;
	required?: boolean;
	content?: Record<string, OpenAPIMediaType>;
	$ref?: string;
}

export interface OpenAPIResponse {
	description?: string;
	content?: Record<string, OpenAPIMediaType>;
	headers?: Record<string, unknown>;
	$ref?: string;
}

export interface OpenAPIOperation {
	operationId?: string;
	summary?: string;
	description?: string;
	tags?: string[];
	deprecated?: boolean;
	parameters?: OpenAPIParameter[];
	requestBody?: OpenAPIRequestBody;
	responses?: Record<string, OpenAPIResponse>;
	security?: SecurityRequirement[];
	servers?: OpenAPIServer[];
}

export type OpenAPIPathItem = {
	summary?: string;
	description?: string;
	parameters?: OpenAPIParameter[];
	servers?: OpenAPIServer[];
	$ref?: string;
} & { [M in OpenAPIMethod]?: OpenAPIOperation };

export interface OpenAPIServer {
	url: string;
	description?: string;
	variables?: Record<string, { default?: string; enum?: string[]; description?: string }>;
}

export type SecurityRequirement = Record<string, string[]>;

export interface SecurityScheme {
	type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect' | 'mutualTLS';
	description?: string;
	name?: string;
	in?: ParameterLocation;
	scheme?: string;
	bearerFormat?: string;
	openIdConnectUrl?: string;
	flows?: Record<
		string,
		{
			authorizationUrl?: string;
			tokenUrl?: string;
			refreshUrl?: string;
			scopes?: Record<string, string>;
		}
	>;
}

export interface OpenAPIComponents {
	schemas?: Record<string, JsonSchema>;
	parameters?: Record<string, OpenAPIParameter>;
	requestBodies?: Record<string, OpenAPIRequestBody>;
	responses?: Record<string, OpenAPIResponse>;
	headers?: Record<string, unknown>;
	securitySchemes?: Record<string, SecurityScheme>;
	pathItems?: Record<string, OpenAPIPathItem>;
}

export interface OpenAPI {
	openapi: string;
	info: {
		title: string;
		description?: string;
		version?: string;
		license?: { name: string; url?: string };
	};
	servers?: OpenAPIServer[];
	security?: SecurityRequirement[];
	components?: OpenAPIComponents;
	paths?: Record<string, OpenAPIPathItem>;
	webhooks?: Record<string, OpenAPIPathItem>;
	$defs?: Record<string, JsonSchema>;
	tags?: { name: string; description?: string }[];
}

/**
 * Validates the minimum structure needed to build tools. `servers` is NOT required:
 * a relative or absent server list is resolved against the document's own origin.
 */
export function isValidOpenAPI(obj: unknown): obj is OpenAPI {
	if (!obj || typeof obj !== 'object') return false;
	const doc = obj as Record<string, unknown>;

	if (typeof doc.openapi !== 'string' || !doc.openapi) return false;
	if (!doc.info || typeof doc.info !== 'object') return false;

	const info = doc.info as Record<string, unknown>;
	if (typeof info.title !== 'string' || !info.title) return false;

	const hasPaths = !!doc.paths && typeof doc.paths === 'object';
	const hasWebhooks = !!doc.webhooks && typeof doc.webhooks === 'object';
	return hasPaths || hasWebhooks;
}

export function isSwagger2(obj: unknown): boolean {
	if (!obj || typeof obj !== 'object') return false;
	const swagger = (obj as Record<string, unknown>).swagger;
	return typeof swagger === 'string' && swagger.startsWith('2.');
}

// #endregion

// #region MCP tools

/** how a tool argument maps back onto the operation that produced it */
export interface ArgumentBinding {
	in: ParameterLocation | 'body';
	name: string;
	style?: string;
	explode?: boolean;
	contentType?: string;
}

export interface ToolDefinition {
	name: string;
	title?: string;
	description?: string;
	inputSchema: JsonSchema;
	outputSchema?: JsonSchema;
	method: string;
	path: string;
	tags: string[];
	operationId: string;
	requestContentType?: string;
	security?: SecurityRequirement[];
	servers?: OpenAPIServer[];
	bindings: Record<string, ArgumentBinding>;
}

export interface ToolTable {
	tools: ToolDefinition[];
	byName: Map<string, ToolDefinition>;
	serverInfo: { name: string; version: string };
	instructions?: string;
	securitySchemes: Record<string, SecurityScheme>;
	security: SecurityRequirement[];
	servers: OpenAPIServer[];
}

// #endregion

// #region JSON-RPC

export const JSONRPC_VERSION = '2.0';

export interface JsonRpcRequest {
	jsonrpc: string;
	id?: string | number | null;
	method: string;
	params?: Record<string, any>;
}

export interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc: string;
	id: string | number | null;
	result?: Record<string, unknown>;
	error?: JsonRpcError;
}

export const ErrorCode = {
	ParseError: -32700,
	InvalidRequest: -32600,
	MethodNotFound: -32601,
	InvalidParams: -32602,
	InternalError: -32603,
	HeaderMismatch: -32020,
	MissingRequiredClientCapability: -32021,
	UnsupportedProtocolVersion: -32022
} as const;

/** true for a JSON-RPC notification: a message carrying no `id` at all */
export function isNotification(msg: JsonRpcRequest): boolean {
	return !('id' in msg) || msg.id === undefined;
}

// #endregion

// #region protocol versions

export const PROTOCOL_2026_07_28 = '2026-07-28';
export const PROTOCOL_2025_11_25 = '2025-11-25';
export const PROTOCOL_2025_06_18 = '2025-06-18';
export const PROTOCOL_2025_03_26 = '2025-03-26';
export const PROTOCOL_2024_11_05 = '2024-11-05';

/** newest first; the order `server/discover` and `UnsupportedProtocolVersionError` report */
export const SUPPORTED_PROTOCOLS = [
	PROTOCOL_2026_07_28,
	PROTOCOL_2025_11_25,
	PROTOCOL_2025_06_18,
	PROTOCOL_2025_03_26,
	PROTOCOL_2024_11_05
] as const;

export type ProtocolVersion = (typeof SUPPORTED_PROTOCOLS)[number];

export const LATEST_PROTOCOL: ProtocolVersion = PROTOCOL_2026_07_28;

/** version a request without an MCP-Protocol-Version header is treated as */
export const FALLBACK_PROTOCOL: ProtocolVersion = PROTOCOL_2025_03_26;

export function isSupportedProtocol(v: string): v is ProtocolVersion {
	return (SUPPORTED_PROTOCOLS as readonly string[]).includes(v);
}

/**
 * 2026-07-28 dropped the initialize handshake and sessions in favour of per-request `_meta`.
 * Everything earlier keeps the handshake, so this split decides which envelope applies.
 */
export function isStatelessEra(v: string): boolean {
	return v >= PROTOCOL_2026_07_28;
}

export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
export const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
export const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
export const META_LOG_LEVEL = 'io.modelcontextprotocol/logLevel';
export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';

// #endregion

// #region MCP content

export interface TextContent {
	type: 'text';
	text: string;
}

export interface ImageContent {
	type: 'image';
	data: string;
	mimeType: string;
}

export interface AudioContent {
	type: 'audio';
	data: string;
	mimeType: string;
}

export interface EmbeddedResource {
	type: 'resource';
	resource: { uri: string; mimeType?: string; text?: string; blob?: string };
}

export type ContentBlock = TextContent | ImageContent | AudioContent | EmbeddedResource;

export interface CallToolResult {
	content: ContentBlock[];
	structuredContent?: JsonValue;
	isError?: boolean;
}

// #endregion
