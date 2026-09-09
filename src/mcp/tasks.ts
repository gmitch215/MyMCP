import type { Env } from '../env';
import type { JsonRpcError } from '../types';
import type { InputRequest } from './mrtr';

export type TaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

export const TERMINAL_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled'];

export interface TaskRecord {
	taskId: string;
	status: TaskStatus;
	statusMessage?: string;
	createdAt: number;
	ttlMs: number;
	pollIntervalMs: number;
	result?: Record<string, unknown>;
	error?: JsonRpcError;
	inputRequests?: Record<string, InputRequest>;
	/** an upstream job endpoint to poll when the API answered 202 with a Location */
	upstreamPoll?: { url: string; headers: Record<string, string> };
	principal?: string;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_POLL_MS = 1500;

/** tasks need a durable handle, so the extension is only offered when KV is bound */
export function tasksEnabled(env: Env): boolean {
	return !!env.MYMCP_KV;
}

function key(taskId: string): string {
	return `task:${taskId}`;
}

export async function createTask(
	env: Env,
	init: Partial<TaskRecord> & { principal?: string } = {}
): Promise<TaskRecord> {
	const record: TaskRecord = {
		taskId: crypto.randomUUID(),
		status: init.status ?? 'working',
		statusMessage: init.statusMessage,
		createdAt: Date.now(),
		ttlMs: init.ttlMs ?? DEFAULT_TTL_MS,
		pollIntervalMs: init.pollIntervalMs ?? DEFAULT_POLL_MS,
		upstreamPoll: init.upstreamPoll,
		inputRequests: init.inputRequests,
		principal: init.principal
	};

	await putTask(env, record);
	return record;
}

export async function putTask(env: Env, record: TaskRecord): Promise<void> {
	if (!env.MYMCP_KV) return;
	await env.MYMCP_KV.put(key(record.taskId), JSON.stringify(record), {
		expirationTtl: Math.max(60, Math.ceil(record.ttlMs / 1000))
	});
}

export async function getTask(env: Env, taskId: string): Promise<TaskRecord | undefined> {
	if (!env.MYMCP_KV || typeof taskId !== 'string' || !taskId) return undefined;

	const raw = await env.MYMCP_KV.get(key(taskId));
	if (!raw) return undefined;

	try {
		return JSON.parse(raw) as TaskRecord;
	} catch {
		return undefined;
	}
}

export async function completeTask(
	env: Env,
	taskId: string,
	result: Record<string, unknown>
): Promise<void> {
	const record = await getTask(env, taskId);
	if (!record || TERMINAL_STATUSES.includes(record.status)) return;
	await putTask(env, { ...record, status: 'completed', result, inputRequests: undefined });
}

export async function failTask(env: Env, taskId: string, error: JsonRpcError): Promise<void> {
	const record = await getTask(env, taskId);
	if (!record || TERMINAL_STATUSES.includes(record.status)) return;
	await putTask(env, { ...record, status: 'failed', error, inputRequests: undefined });
}

export async function cancelTask(env: Env, taskId: string): Promise<TaskRecord | undefined> {
	const record = await getTask(env, taskId);
	if (!record) return undefined;
	if (TERMINAL_STATUSES.includes(record.status)) return record;

	const cancelled: TaskRecord = { ...record, status: 'cancelled', inputRequests: undefined };
	await putTask(env, cancelled);
	return cancelled;
}

/** the wire shape a task takes in `tasks/get` and `CreateTaskResult` */
export function taskPayload(record: TaskRecord): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		taskId: record.taskId,
		status: record.status,
		createdAt: new Date(record.createdAt).toISOString(),
		ttlMs: record.ttlMs,
		pollIntervalMs: record.pollIntervalMs
	};

	if (record.statusMessage) payload.statusMessage = record.statusMessage;
	if (record.status === 'completed' && record.result) payload.result = record.result;
	if (record.status === 'failed' && record.error) payload.error = record.error;
	if (record.status === 'input_required' && record.inputRequests) {
		payload.inputRequests = record.inputRequests;
	}
	return payload;
}

export const DEFAULT_TASK_TTL_MS = DEFAULT_TTL_MS;
export const DEFAULT_TASK_POLL_MS = DEFAULT_POLL_MS;
