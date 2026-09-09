import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	McpSseSession,
	messageEndpoint,
	openSseStream,
	pushToSession,
	sseUnavailable
} from '../../src/mcp/sse';
import type { SseBinding } from '../../src/mcp/sse';

afterEach(() => vi.unstubAllGlobals());

/** an in-process stand-in for the Durable Object namespace, backed by one real session */
function bindingFor(session: McpSseSession): SseBinding {
	return {
		idFromName: (name: string) => name as unknown as DurableObjectId,
		get: () =>
			({
				fetch: (input: RequestInfo, init?: RequestInit) =>
					session.fetch(new Request(typeof input === 'string' ? input : String(input), init))
			}) as unknown as DurableObjectStub
	};
}

async function readEvents(response: Response, count: number): Promise<string[]> {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	const events: string[] = [];
	let buffer = '';

	while (events.length < count) {
		const { done, value } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: true });
		const parts = buffer.split('\n\n');
		buffer = parts.pop() ?? '';
		for (const part of parts) if (part.trim()) events.push(part);
	}

	await reader.cancel();
	return events;
}

describe('messageEndpoint', () => {
	it('points at the message channel for the same server', () => {
		const endpoint = messageEndpoint(new URL('https://mymcp.test/petstore/sse'), 'abc-123');
		expect(endpoint).toBe('/petstore/messages?sessionId=abc-123');
	});

	it('handles a trailing slash on the sse path', () => {
		const endpoint = messageEndpoint(new URL('https://mymcp.test/petstore/sse/'), 'x');
		expect(endpoint).toBe('/petstore/messages?sessionId=x');
	});

	it('percent-encodes the session id', () => {
		expect(messageEndpoint(new URL('https://mymcp.test/a/sse'), 'a b')).toContain(
			'sessionId=a%20b'
		);
	});
});

describe('McpSseSession', () => {
	it('announces the message endpoint as the first event', async () => {
		const session = new McpSseSession();
		const response = await session.fetch(
			new Request('https://session/open?endpoint=%2Fpetstore%2Fmessages%3FsessionId%3Dx')
		);

		expect(response.headers.get('Content-Type')).toBe('text/event-stream');
		expect(response.headers.get('X-Accel-Buffering')).toBe('no');

		const events = await readEvents(response, 1);
		expect(events[0]).toContain('event: endpoint');
		expect(events[0]).toContain('/petstore/messages?sessionId=x');
	});

	it('delivers a pushed message on the open stream', async () => {
		const session = new McpSseSession();
		const stream = await session.fetch(new Request('https://session/open?endpoint=%2Fm'));

		const push = await session.fetch(
			new Request('https://session/push', { method: 'POST', body: '{"jsonrpc":"2.0","id":1}' })
		);
		expect(push.status).toBe(202);

		const events = await readEvents(stream, 2);
		expect(events[1]).toContain('event: message');
		expect(events[1]).toContain('"id":1');
	});

	it('refuses a push with no open stream', async () => {
		const session = new McpSseSession();
		const response = await session.fetch(
			new Request('https://session/push', { method: 'POST', body: '{}' })
		);

		expect(response.status).toBe(409);
	});

	it('closes the stream on request', async () => {
		const session = new McpSseSession();
		await session.fetch(new Request('https://session/open?endpoint=%2Fm'));

		expect((await session.fetch(new Request('https://session/close'))).status).toBe(204);
		expect(
			(await session.fetch(new Request('https://session/push', { method: 'POST', body: '{}' })))
				.status
		).toBe(409);
	});

	it('404s an unknown session path', async () => {
		const session = new McpSseSession();
		expect((await session.fetch(new Request('https://session/other'))).status).toBe(404);
	});

	it('replaces an existing stream when reopened', async () => {
		const session = new McpSseSession();
		const first = await session.fetch(new Request('https://session/open?endpoint=%2Fa'));
		await readEvents(first, 1);

		const second = await session.fetch(new Request('https://session/open?endpoint=%2Fb'));
		const events = await readEvents(second, 1);

		expect(events[0]).toContain('/b');
	});
});

describe('openSseStream and pushToSession', () => {
	it('opens a stream carrying the derived endpoint', async () => {
		const session = new McpSseSession();
		const response = await openSseStream(
			bindingFor(session),
			new URL('https://mymcp.test/petstore/sse')
		);

		const events = await readEvents(response, 1);
		expect(events[0]).toContain('/petstore/messages?sessionId=');
	});

	it('reports whether a push was delivered', async () => {
		const session = new McpSseSession();
		const binding = bindingFor(session);

		expect(await pushToSession(binding, 'sid', { a: 1 })).toBe(false);

		await session.fetch(new Request('https://session/open?endpoint=%2Fm'));
		expect(await pushToSession(binding, 'sid', { a: 1 })).toBe(true);
	});
});

describe('sseUnavailable', () => {
	it('points the caller at the Streamable HTTP endpoint', async () => {
		const response = sseUnavailable('https://mymcp.test/petstore/mcp');
		const body = (await response.json()) as { error: { message: string } };

		expect(response.status).toBe(405);
		expect(body.error.message).toContain('https://mymcp.test/petstore/mcp');
		expect(body.error.message).toContain('MCP_SSE');
	});
});
