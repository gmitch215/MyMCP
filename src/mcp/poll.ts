import type { Env } from '../env';
import { exemptHosts, maxResponseBytes } from '../env';
import { readCapped, safeFetch } from '../net';
import type { TaskRecord } from './tasks';
import { putTask } from './tasks';

/**
 * Advances a task backed by an upstream job endpoint.
 *
 * The job is polled when the client reads the task rather than from a background worker, so a
 * stateless request handler is enough to carry a long-running upstream call to completion.
 */
export async function pollUpstreamJob(
	env: Env,
	record: TaskRecord,
	credentialHosts?: Set<string>
): Promise<TaskRecord> {
	if (!record.upstreamPoll) return record;

	if (Date.now() > record.createdAt + record.ttlMs) {
		const expired: TaskRecord = {
			...record,
			status: 'failed',
			error: { code: -32603, message: 'The upstream job did not finish before the task expired' }
		};
		await putTask(env, expired);
		return expired;
	}

	let response: Response;
	try {
		response = await safeFetch(
			record.upstreamPoll.url,
			{ method: 'GET', headers: { ...record.upstreamPoll.headers, Accept: 'application/json' } },
			{ timeoutMs: 15_000, credentialHosts, exemptHosts: exemptHosts(env) }
		);
	} catch (error) {
		const failed: TaskRecord = {
			...record,
			status: 'failed',
			error: {
				code: -32603,
				message: `Polling the upstream job failed: ${error instanceof Error ? error.message : String(error)}`
			}
		};
		await putTask(env, failed);
		return failed;
	}

	// still working: many APIs keep answering 202 until the job lands
	if (response.status === 202) {
		const retryAfter = Number(response.headers.get('retry-after'));
		const updated: TaskRecord = {
			...record,
			pollIntervalMs:
				Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : record.pollIntervalMs
		};
		await putTask(env, updated);
		return updated;
	}

	const bytes = await readCapped(response, maxResponseBytes(env)).catch(() => new Uint8Array(0));
	const text = new TextDecoder().decode(bytes);

	if (!response.ok) {
		const failed: TaskRecord = {
			...record,
			status: 'failed',
			error: {
				code: -32603,
				message: `The upstream job failed: ${response.status} ${response.statusText}`,
				data: text.slice(0, 2000)
			}
		};
		await putTask(env, failed);
		return failed;
	}

	const content = [{ type: 'text', text: text || `${response.status} ${response.statusText}` }];
	const result: Record<string, unknown> = { content };

	if ((response.headers.get('content-type') ?? '').includes('json') && text.trim()) {
		try {
			result.structuredContent = JSON.parse(text);
		} catch {
			// a body that claims JSON but is not still returns as text
		}
	}

	const completed: TaskRecord = {
		...record,
		status: 'completed',
		result,
		upstreamPoll: undefined
	};
	await putTask(env, completed);
	return completed;
}
