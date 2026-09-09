import type { SuppliedCredentials } from '../auth/upstream';
import { applySecurity, effectiveSecurity } from '../auth/upstream';
import type { Env } from '../env';
import { exemptHosts, fetchTimeoutMs, maxResponseBytes } from '../env';
import { executeCall } from '../openapi/call';
import type { ToolFilter } from '../openapi/tools';
import { fromBase64Url, requestDigest, seal, toBase64Url, unseal } from '../state';
import type {
	JsonRpcError,
	JsonSchema,
	ProtocolVersion,
	ToolDefinition,
	ToolTable
} from '../types';
import { ErrorCode, TASKS_EXTENSION } from '../types';
import {
	buildElicitationSchema,
	confirmationSchema,
	formElicitation,
	readElicitResult,
	supportsElicitation,
	supportsExtension,
	urlElicitation
} from './mrtr';
import {
	completeTask,
	createTask,
	cancelTask,
	failTask,
	getTask,
	taskPayload,
	tasksEnabled
} from './tasks';

const TOOLS_PAGE_SIZE = 500;
const LIST_TTL_MS = 300_000;
const STATE_TTL_MS = 10 * 60 * 1000;

export interface McpContext {
	env: Env;
	table: ToolTable;
	sourceUrl: string;
	baseUrl: string;
	credentialHosts: Set<string>;
	supplied: SuppliedCredentials;
	protocol: ProtocolVersion;
	clientCapabilities: Record<string, any>;
	filter: ToolFilter;
	/** methods that require an explicit confirmation before executing */
	confirmMethods: Set<string>;
	principal?: string;
	/** upstream tokens held for the authenticated principal, keyed by security scheme */
	storedCredentials?: Map<string, string>;
	/** builds the URL that starts an upstream OAuth flow; absent when Tier 2 auth is off */
	connectUrl?: (schemes: string[]) => string;
	waitUntil?: (promise: Promise<unknown>) => void;
}

export interface DispatchOutcome {
	result?: Record<string, unknown>;
	error?: JsonRpcError;
	/** HTTP status the transport should use; method-not-found is 404 per Streamable HTTP */
	httpStatus?: number;
	/** true for list-shaped results, which carry cache hints */
	cacheable?: boolean;
}

function ok(result: Record<string, unknown>, cacheable = false): DispatchOutcome {
	return { result, cacheable };
}

function fail(code: number, message: string, data?: unknown, httpStatus?: number): DispatchOutcome {
	return { error: { code, message, ...(data !== undefined ? { data } : {}) }, httpStatus };
}

function encodeCursor(index: number): string {
	return toBase64Url(new TextEncoder().encode(String(index)));
}

function decodeCursor(cursor: unknown): number | undefined {
	if (cursor === undefined || cursor === null) return 0;
	if (typeof cursor !== 'string') return undefined;

	try {
		const value = Number(new TextDecoder().decode(fromBase64Url(cursor)));
		return Number.isInteger(value) && value >= 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

function toolPayload(tool: ToolDefinition): Record<string, unknown> {
	return {
		name: tool.name,
		...(tool.title ? { title: tool.title } : {}),
		description: tool.description,
		inputSchema: tool.inputSchema,
		...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
		annotations: {
			readOnlyHint: tool.method === 'GET' || tool.method === 'HEAD',
			destructiveHint: tool.method === 'DELETE',
			idempotentHint: ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'].includes(tool.method)
		}
	};
}

function promptPayload(tool: ToolDefinition): Record<string, unknown> {
	const properties = (tool.inputSchema.properties ?? {}) as Record<string, JsonSchema>;
	const required: string[] = Array.isArray(tool.inputSchema.required)
		? tool.inputSchema.required
		: [];

	return {
		name: tool.name,
		...(tool.title ? { title: tool.title } : {}),
		description: tool.description,
		arguments: Object.entries(properties).map(([name, schema]) => ({
			name,
			description: typeof schema?.description === 'string' ? schema.description : '',
			required: required.includes(name)
		}))
	};
}

function missingRequired(tool: ToolDefinition, args: Record<string, unknown>): string[] {
	const required: string[] = Array.isArray(tool.inputSchema.required)
		? tool.inputSchema.required
		: [];
	return required.filter((name) => args[name] === undefined || args[name] === null);
}

function describeCall(tool: ToolDefinition): string {
	return `${tool.method} ${tool.path}`;
}

/** Handles one MCP method. Envelope concerns (resultType, _meta) belong to the transport. */
export async function dispatch(
	method: string,
	params: Record<string, any>,
	ctx: McpContext
): Promise<DispatchOutcome> {
	switch (method) {
		case 'server/discover':
			return ok(
				{
					supportedVersions: [...serverVersions()],
					capabilities: capabilities(ctx),
					instructions: ctx.table.instructions
				},
				true
			);

		case 'initialize':
			return ok({
				protocolVersion: ctx.protocol,
				capabilities: capabilities(ctx),
				serverInfo: ctx.table.serverInfo,
				instructions: ctx.table.instructions
			});

		case 'ping':
			return ok({});

		case 'tools/list':
			return listTools(params, ctx);

		case 'tools/call':
			return callTool(params, ctx);

		case 'prompts/list':
			return listPrompts(params, ctx);

		case 'prompts/get':
			return getPrompt(params, ctx);

		case 'resources/list':
			return ok(
				{
					resources: [
						{
							uri: descriptionUri(ctx),
							name: `${ctx.table.serverInfo.name} OpenAPI description`,
							description: 'The OpenAPI document these tools were generated from.',
							mimeType: 'application/json'
						}
					]
				},
				true
			);

		case 'resources/templates/list':
			return ok({ resourceTemplates: [] }, true);

		case 'resources/read':
			return readResource(params, ctx);

		case 'completion/complete':
			return complete(params, ctx);

		case 'tasks/get':
			return taskGet(params, ctx);

		case 'tasks/update':
			return taskUpdate(params, ctx);

		case 'tasks/cancel':
			return taskCancel(params, ctx);

		default:
			return fail(ErrorCode.MethodNotFound, `Method not found: ${method}`, undefined, 404);
	}
}

function serverVersions(): readonly string[] {
	return ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
}

export function capabilities(ctx: McpContext): Record<string, unknown> {
	const caps: Record<string, unknown> = {
		tools: {},
		prompts: {},
		resources: {},
		completions: {}
	};

	if (tasksEnabled(ctx.env)) caps.extensions = { [TASKS_EXTENSION]: {} };
	return caps;
}

function descriptionUri(ctx: McpContext): string {
	return `openapi://${encodeURIComponent(ctx.sourceUrl)}`;
}

function listTools(params: Record<string, any>, ctx: McpContext): DispatchOutcome {
	const start = decodeCursor(params?.cursor);
	if (start === undefined) return fail(ErrorCode.InvalidParams, 'Invalid cursor');

	const page = ctx.table.tools.slice(start, start + TOOLS_PAGE_SIZE);
	const next = start + TOOLS_PAGE_SIZE;

	return ok(
		{
			tools: page.map(toolPayload),
			...(next < ctx.table.tools.length ? { nextCursor: encodeCursor(next) } : {})
		},
		true
	);
}

function listPrompts(params: Record<string, any>, ctx: McpContext): DispatchOutcome {
	const start = decodeCursor(params?.cursor);
	if (start === undefined) return fail(ErrorCode.InvalidParams, 'Invalid cursor');

	const page = ctx.table.tools.slice(start, start + TOOLS_PAGE_SIZE);
	const next = start + TOOLS_PAGE_SIZE;

	return ok(
		{
			prompts: page.map(promptPayload),
			...(next < ctx.table.tools.length ? { nextCursor: encodeCursor(next) } : {})
		},
		true
	);
}

function getPrompt(params: Record<string, any>, ctx: McpContext): DispatchOutcome {
	const name = params?.name;
	if (typeof name !== 'string') return fail(ErrorCode.InvalidParams, 'A prompt name is required');

	const tool = ctx.table.byName.get(name);
	if (!tool) return fail(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);

	const args = (params.arguments ?? {}) as Record<string, unknown>;
	const supplied = Object.entries(args)
		.map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`)
		.join('\n');

	const text = [
		`Call the \`${tool.name}\` tool, which performs ${describeCall(tool)}.`,
		tool.description ? `\nWhat it does: ${tool.description}` : '',
		supplied ? `\nArguments provided:\n${supplied}` : ''
	]
		.filter(Boolean)
		.join('\n');

	return ok({
		description: tool.description,
		messages: [{ role: 'user', content: { type: 'text', text } }]
	});
}

async function readResource(
	params: Record<string, any>,
	ctx: McpContext
): Promise<DispatchOutcome> {
	const uri = params?.uri;
	if (typeof uri !== 'string') return fail(ErrorCode.InvalidParams, 'A resource uri is required');
	if (uri !== descriptionUri(ctx)) return fail(ErrorCode.InvalidParams, `Unknown resource: ${uri}`);

	const summary = {
		source: ctx.sourceUrl,
		server: ctx.table.serverInfo,
		baseUrl: ctx.baseUrl,
		toolCount: ctx.table.tools.length,
		tools: ctx.table.tools.map((t) => ({
			name: t.name,
			method: t.method,
			path: t.path,
			tags: t.tags
		}))
	};

	return ok({
		contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(summary, null, 2) }]
	});
}

function complete(params: Record<string, any>, ctx: McpContext): DispatchOutcome {
	const ref = params?.ref;
	const argument = params?.argument;

	if (!ref || typeof argument?.name !== 'string') {
		return ok({ completion: { values: [], total: 0, hasMore: false } });
	}

	const toolName = typeof ref.name === 'string' ? ref.name : undefined;
	const tool = toolName ? ctx.table.byName.get(toolName) : undefined;
	if (!tool) return ok({ completion: { values: [], total: 0, hasMore: false } });

	const properties = (tool.inputSchema.properties ?? {}) as Record<string, JsonSchema>;
	const schema = properties[argument.name];
	const options: string[] = Array.isArray(schema?.enum) ? schema.enum.map((v) => String(v)) : [];

	const prefix = typeof argument.value === 'string' ? argument.value : '';
	const values = options.filter((v) => v.startsWith(prefix)).slice(0, 100);

	return ok({ completion: { values, total: values.length, hasMore: false } });
}

interface CallState {
	tool: string;
	args: Record<string, unknown>;
	stage: 'arguments' | 'confirm' | 'credentials';
}

async function callTool(params: Record<string, any>, ctx: McpContext): Promise<DispatchOutcome> {
	const name = params?.name;
	if (typeof name !== 'string') return fail(ErrorCode.InvalidParams, 'A tool name is required');

	const tool = ctx.table.byName.get(name);
	if (!tool) {
		return fail(ErrorCode.InvalidParams, `Unknown tool: ${name}`, {
			available: ctx.table.tools.slice(0, 25).map((t) => t.name)
		});
	}

	let args: Record<string, unknown> =
		params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
			? { ...(params.arguments as Record<string, unknown>) }
			: {};

	const digest = await requestDigest('tools/call', { name });

	// an MRTR retry carries the state we sealed alongside the client's answers
	let priorStage: CallState['stage'] | undefined;
	if (typeof params.requestState === 'string') {
		const state = await unseal<CallState>(ctx.env, params.requestState, {
			principal: ctx.principal,
			digest
		});
		if (!state) {
			return fail(ErrorCode.InvalidParams, 'The request state is invalid or has expired');
		}
		args = { ...state.args, ...args };
		priorStage = state.stage;
	}

	const responses = (params.inputResponses ?? {}) as Record<string, unknown>;

	const argumentAnswer = readElicitResult(responses['arguments']);
	if (argumentAnswer) {
		if (argumentAnswer.action !== 'accept') {
			return ok(toolError('The request was cancelled before the arguments were provided.'));
		}
		Object.assign(args, argumentAnswer.content ?? {});
	}

	const confirmAnswer = readElicitResult(responses['confirm']);
	const confirmed = confirmAnswer?.action === 'accept' && confirmAnswer.content?.confirm === true;
	if (confirmAnswer && !confirmed) {
		return ok(toolError('The operation was not confirmed, so nothing was sent.'));
	}

	const credentialAnswer = readElicitResult(responses['credentials']);

	// #region elicitation gates

	const missing = missingRequired(tool, args);
	if (
		missing.length > 0 &&
		priorStage !== 'arguments' &&
		supportsElicitation(ctx.clientCapabilities, 'form')
	) {
		const schema = buildElicitationSchema(tool, missing);
		if (schema) {
			return ok({
				resultType: 'input_required',
				inputRequests: {
					arguments: formElicitation(
						`\`${tool.name}\` needs ${missing.join(', ')} before it can run ${describeCall(tool)}.`,
						schema
					)
				},
				requestState: await sealState(ctx, { tool: tool.name, args, stage: 'arguments' }, digest)
			});
		}
	}

	if (missing.length > 0) {
		return ok(
			toolError(`Missing required argument${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`)
		);
	}

	const needsConfirmation =
		ctx.confirmMethods.has(tool.method) &&
		!confirmed &&
		supportsElicitation(ctx.clientCapabilities, 'form');

	if (needsConfirmation) {
		return ok({
			resultType: 'input_required',
			inputRequests: {
				confirm: formElicitation(
					`\`${tool.name}\` will perform ${describeCall(tool)} against ${ctx.baseUrl}. Confirm to continue.`,
					confirmationSchema(`Run ${describeCall(tool)}`)
				)
			},
			requestState: await sealState(ctx, { tool: tool.name, args, stage: 'confirm' }, digest)
		});
	}

	// #endregion

	const requirements = effectiveSecurity(tool.security, ctx.table.security);
	const credentials = applySecurity(
		ctx.table.securitySchemes,
		requirements,
		ctx.supplied,
		ctx.storedCredentials
	);

	if (
		credentials.missing.length > 0 &&
		!credentialAnswer &&
		priorStage !== 'credentials' &&
		ctx.connectUrl &&
		supportsElicitation(ctx.clientCapabilities, 'url')
	) {
		return ok({
			resultType: 'input_required',
			inputRequests: {
				credentials: urlElicitation(
					`\`${tool.name}\` needs access to ${ctx.baseUrl}. Sign in to connect your account.`,
					ctx.connectUrl(credentials.missing)
				)
			},
			requestState: await sealState(ctx, { tool: tool.name, args, stage: 'credentials' }, digest)
		});
	}

	const wantsTask =
		tasksEnabled(ctx.env) && supportsExtension(ctx.clientCapabilities, TASKS_EXTENSION);

	const outcome = await executeCall(tool, args, ctx.baseUrl, credentials, {
		timeoutMs: fetchTimeoutMs(ctx.env),
		maxResponseBytes: maxResponseBytes(ctx.env),
		credentialHosts: ctx.credentialHosts,
		exemptHosts: exemptHosts(ctx.env)
	});

	// an async upstream hands back a job pointer; surface it as a task rather than a dead end
	if (wantsTask && outcome.status === 202 && outcome.location) {
		const task = await createTask(ctx.env, {
			statusMessage: `Waiting on ${describeCall(tool)}`,
			pollIntervalMs: outcome.retryAfterMs,
			upstreamPoll: { url: outcome.location, headers: credentials.headers },
			principal: ctx.principal
		});
		return ok({ resultType: 'task', ...taskPayload(task) });
	}

	if (credentials.missing.length > 0 && outcome.result.isError) {
		outcome.result.content.push({
			type: 'text',
			text:
				`No credential was supplied for security scheme${credentials.missing.length > 1 ? 's' : ''} ` +
				`${credentials.missing.join(', ')}. Pass one with the X-Mcp-Upstream-Authorization header.`
		});
	}

	return ok(outcome.result as unknown as Record<string, unknown>);
}

function toolError(message: string): Record<string, unknown> {
	return { content: [{ type: 'text', text: message }], isError: true };
}

async function sealState(ctx: McpContext, state: CallState, digest: string): Promise<string> {
	return seal(ctx.env, state, STATE_TTL_MS, ctx.principal, digest);
}

async function taskGet(params: Record<string, any>, ctx: McpContext): Promise<DispatchOutcome> {
	if (!tasksEnabled(ctx.env)) {
		return fail(
			ErrorCode.MethodNotFound,
			'Tasks are not enabled on this deployment',
			undefined,
			404
		);
	}

	const taskId = params?.taskId;
	const record = await getTask(ctx.env, taskId);
	if (!record) return fail(ErrorCode.InvalidParams, `Unknown task: ${String(taskId)}`);
	if (record.principal !== undefined && record.principal !== ctx.principal) {
		return fail(ErrorCode.InvalidParams, `Unknown task: ${String(taskId)}`);
	}

	// poll-on-read keeps the upstream job moving without needing a background worker
	if (record.status === 'working' && record.upstreamPoll) {
		const { pollUpstreamJob } = await import('./poll');
		const advanced = await pollUpstreamJob(ctx.env, record, ctx.credentialHosts);
		return ok(taskPayload(advanced));
	}

	return ok(taskPayload(record));
}

async function taskUpdate(params: Record<string, any>, ctx: McpContext): Promise<DispatchOutcome> {
	if (!tasksEnabled(ctx.env)) {
		return fail(
			ErrorCode.MethodNotFound,
			'Tasks are not enabled on this deployment',
			undefined,
			404
		);
	}

	const taskId = params?.taskId;
	const record = await getTask(ctx.env, taskId);
	if (!record) return fail(ErrorCode.InvalidParams, `Unknown task: ${String(taskId)}`);

	const responses = (params?.inputResponses ?? {}) as Record<string, unknown>;
	const answered = Object.keys(record.inputRequests ?? {}).filter(
		(k) => responses[k] !== undefined
	);

	if (answered.length > 0) {
		const remaining = { ...(record.inputRequests ?? {}) };
		for (const k of answered) delete remaining[k];

		await import('./tasks').then(({ putTask }) =>
			putTask(ctx.env, {
				...record,
				status: Object.keys(remaining).length > 0 ? 'input_required' : 'working',
				inputRequests: Object.keys(remaining).length > 0 ? remaining : undefined
			})
		);
	}

	return ok({});
}

async function taskCancel(params: Record<string, any>, ctx: McpContext): Promise<DispatchOutcome> {
	if (!tasksEnabled(ctx.env)) {
		return fail(
			ErrorCode.MethodNotFound,
			'Tasks are not enabled on this deployment',
			undefined,
			404
		);
	}

	const record = await cancelTask(ctx.env, params?.taskId);
	if (!record) return fail(ErrorCode.InvalidParams, `Unknown task: ${String(params?.taskId)}`);
	return ok({});
}

export { LIST_TTL_MS, TOOLS_PAGE_SIZE, completeTask, failTask };
