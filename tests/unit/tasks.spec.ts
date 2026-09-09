import { env as testEnv } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env';
import worker from '../../src/index';
import { pollUpstreamJob } from '../../src/mcp/poll';
import {
	cancelTask,
	completeTask,
	createTask,
	failTask,
	getTask,
	taskPayload,
	tasksEnabled
} from '../../src/mcp/tasks';
import { clearToolTableCache } from '../../src/resolve';
import { TASKS_EXTENSION } from '../../src/types';
import { stubFetch } from '../helpers';

const kvEnv = testEnv as unknown as Env;

const SPEC = JSON.stringify({
	openapi: '3.1.0',
	info: { title: 'Async API', description: 'async', version: '1.0.0' },
	servers: [{ url: 'https://api.async.example' }],
	paths: { '/reports': { post: { operationId: 'createReport', responses: {} } } }
});

const SPEC_URL = 'https://api.async.example/openapi.json';
const MCP = `https://mymcp.test/${encodeURIComponent(SPEC_URL)}/mcp`;

const ctx = {
	waitUntil: () => undefined,
	passThroughOnException: () => undefined
} as unknown as ExecutionContext;

function rpcWithTasks(method: string, params: Record<string, unknown>, name?: string): Request {
	return new Request(MCP, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'MCP-Protocol-Version': '2026-07-28',
			'Mcp-Method': method,
			...(name ? { 'Mcp-Name': name } : {})
		},
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method,
			params: {
				...params,
				_meta: {
					'io.modelcontextprotocol/protocolVersion': '2026-07-28',
					'io.modelcontextprotocol/clientCapabilities': {
						extensions: { [TASKS_EXTENSION]: {} }
					}
				}
			}
		})
	});
}

beforeEach(() => clearToolTableCache());
afterEach(() => clearToolTableCache());

describe('tasksEnabled', () => {
	it('is off without KV and on with it', () => {
		expect(tasksEnabled({})).toBe(false);
		expect(tasksEnabled(kvEnv)).toBe(true);
	});
});

describe('task lifecycle', () => {
	it('creates a task in the working state', async () => {
		const task = await createTask(kvEnv, { statusMessage: 'starting' });

		expect(task.status).toBe('working');
		expect(task.taskId).toMatch(/[0-9a-f-]{36}/);
		expect((await getTask(kvEnv, task.taskId))?.statusMessage).toBe('starting');
	});

	it('moves to completed and carries the result', async () => {
		const task = await createTask(kvEnv);
		await completeTask(kvEnv, task.taskId, { content: [{ type: 'text', text: 'done' }] });

		const loaded = (await getTask(kvEnv, task.taskId))!;
		expect(loaded.status).toBe('completed');
		expect(taskPayload(loaded).result).toBeDefined();
	});

	it('moves to failed and carries the error', async () => {
		const task = await createTask(kvEnv);
		await failTask(kvEnv, task.taskId, { code: -32603, message: 'upstream exploded' });

		const loaded = (await getTask(kvEnv, task.taskId))!;
		expect(loaded.status).toBe('failed');
		expect((taskPayload(loaded).error as { message: string }).message).toBe('upstream exploded');
	});

	it('cancels cooperatively', async () => {
		const task = await createTask(kvEnv);
		expect((await cancelTask(kvEnv, task.taskId))?.status).toBe('cancelled');
	});

	it('does not move a task out of a terminal state', async () => {
		const task = await createTask(kvEnv);
		await cancelTask(kvEnv, task.taskId);
		await completeTask(kvEnv, task.taskId, { content: [] });

		expect((await getTask(kvEnv, task.taskId))?.status).toBe('cancelled');
	});

	it('returns undefined for an unknown task', async () => {
		expect(await getTask(kvEnv, 'not-a-task')).toBeUndefined();
	});

	it('omits result and error while still working', () => {
		const payload = taskPayload({
			taskId: 'x',
			status: 'working',
			createdAt: Date.now(),
			ttlMs: 1000,
			pollIntervalMs: 500,
			result: { content: [] }
		});

		expect(payload.result).toBeUndefined();
		expect(payload.status).toBe('working');
	});
});

describe('async upstream jobs', () => {
	it('returns a task when the API answers 202 with a job location', async () => {
		stubFetch({
			[SPEC_URL]: { body: SPEC },
			'https://api.async.example/reports': {
				status: 202,
				headers: { Location: 'https://api.async.example/jobs/1', 'Retry-After': '2' }
			}
		});

		const response = await worker.fetch(
			rpcWithTasks('tools/call', { name: 'createReport', arguments: {} }, 'createReport'),
			kvEnv,
			ctx
		);
		const body = (await response.json()) as any;

		expect(body.result.resultType).toBe('task');
		expect(body.result.status).toBe('working');
		expect(body.result.pollIntervalMs).toBe(2000);
	});

	it('does not return a task to a client that did not opt in', async () => {
		stubFetch({
			[SPEC_URL]: { body: SPEC },
			'https://api.async.example/reports': {
				status: 202,
				headers: { Location: 'https://api.async.example/jobs/1' }
			}
		});

		const request = new Request(MCP, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'MCP-Protocol-Version': '2026-07-28',
				'Mcp-Method': 'tools/call',
				'Mcp-Name': 'createReport'
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: {
					name: 'createReport',
					arguments: {},
					_meta: {
						'io.modelcontextprotocol/protocolVersion': '2026-07-28',
						'io.modelcontextprotocol/clientCapabilities': {}
					}
				}
			})
		});

		const body = (await (await worker.fetch(request, kvEnv, ctx)).json()) as any;
		expect(body.result.resultType).toBe('complete');
	});

	it('advertises the tasks extension only when KV is bound', async () => {
		stubFetch({ [SPEC_URL]: { body: SPEC } });

		const withKv = (await (
			await worker.fetch(rpcWithTasks('server/discover', {}), kvEnv, ctx)
		).json()) as any;
		expect(withKv.result.capabilities.extensions[TASKS_EXTENSION]).toBeDefined();

		clearToolTableCache();
		const withoutKv = (await (
			await worker.fetch(rpcWithTasks('server/discover', {}), {}, ctx)
		).json()) as any;
		expect(withoutKv.result.capabilities.extensions).toBeUndefined();
	});
});

describe('pollUpstreamJob', () => {
	it('completes the task when the job finishes', async () => {
		stubFetch({ 'https://api.async.example/jobs/1': { body: '{"rows":3}' } });

		const task = await createTask(kvEnv, {
			upstreamPoll: { url: 'https://api.async.example/jobs/1', headers: {} }
		});
		const advanced = await pollUpstreamJob(kvEnv, task);

		expect(advanced.status).toBe('completed');
		expect(advanced.result?.structuredContent).toEqual({ rows: 3 });
	});

	it('stays working while the job still answers 202', async () => {
		stubFetch({
			'https://api.async.example/jobs/1': { status: 202, headers: { 'Retry-After': '5' } }
		});

		const task = await createTask(kvEnv, {
			upstreamPoll: { url: 'https://api.async.example/jobs/1', headers: {} }
		});
		const advanced = await pollUpstreamJob(kvEnv, task);

		expect(advanced.status).toBe('working');
		expect(advanced.pollIntervalMs).toBe(5000);
	});

	it('fails the task when the job errors', async () => {
		stubFetch({ 'https://api.async.example/jobs/1': { status: 500, body: 'exploded' } });

		const task = await createTask(kvEnv, {
			upstreamPoll: { url: 'https://api.async.example/jobs/1', headers: {} }
		});
		const advanced = await pollUpstreamJob(kvEnv, task);

		expect(advanced.status).toBe('failed');
		expect(advanced.error?.message).toContain('500');
	});

	it('fails the task once it outlives its ttl', async () => {
		const task = await createTask(kvEnv, {
			ttlMs: 1,
			upstreamPoll: { url: 'https://api.async.example/jobs/1', headers: {} }
		});
		const expired = { ...task, createdAt: Date.now() - 60_000 };
		const advanced = await pollUpstreamJob(kvEnv, expired);

		expect(advanced.status).toBe('failed');
		expect(advanced.error?.message).toContain('expired');
	});
});

describe('tasks methods over the transport', () => {
	it('reports tasks/get for an unknown task', async () => {
		stubFetch({ [SPEC_URL]: { body: SPEC } });

		const body = (await (
			await worker.fetch(rpcWithTasks('tasks/get', { taskId: 'nope' }), kvEnv, ctx)
		).json()) as any;

		expect(body.error.code).toBe(-32602);
	});

	it('returns method-not-found for tasks when KV is absent', async () => {
		stubFetch({ [SPEC_URL]: { body: SPEC } });

		const response = await worker.fetch(rpcWithTasks('tasks/get', { taskId: 'x' }), {}, ctx);
		expect(response.status).toBe(404);
		expect(((await response.json()) as any).error.code).toBe(-32601);
	});

	it('acknowledges tasks/cancel', async () => {
		stubFetch({ [SPEC_URL]: { body: SPEC } });
		const task = await createTask(kvEnv);

		const body = (await (
			await worker.fetch(rpcWithTasks('tasks/cancel', { taskId: task.taskId }), kvEnv, ctx)
		).json()) as any;

		expect(body.result.resultType).toBe('complete');
		expect((await getTask(kvEnv, task.taskId))?.status).toBe('cancelled');
	});

	it('ignores input responses for keys the task does not expect', async () => {
		stubFetch({ [SPEC_URL]: { body: SPEC } });
		const task = await createTask(kvEnv);

		const response = await worker.fetch(
			rpcWithTasks('tasks/update', { taskId: task.taskId, inputResponses: { unknown: {} } }),
			kvEnv,
			ctx
		);

		expect(response.status).toBe(200);
		expect((await getTask(kvEnv, task.taskId))?.status).toBe('working');
	});
});
