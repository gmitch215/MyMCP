import { JSONRPC_VERSION } from '../types';

const encoder = new TextEncoder();

/**
 * Bridges the two halves of the deprecated 2024-11-05 HTTP+SSE transport.
 *
 * That transport needs the GET stream and the POST message channel to share state, which a
 * stateless Worker cannot do on its own. One Durable Object per session owns the open stream and
 * accepts messages pushed to it from any request.
 */
export class McpSseSession implements DurableObject {
	private controller?: ReadableStreamDefaultController<Uint8Array>;
	private keepAlive?: ReturnType<typeof setInterval>;

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname.endsWith('/open')) return this.open(url.searchParams.get('endpoint') ?? '');
		if (url.pathname.endsWith('/push')) return this.push(await request.text());
		if (url.pathname.endsWith('/close')) return this.close();

		return new Response('Not found', { status: 404 });
	}

	private open(endpoint: string): Response {
		this.stop();

		// enqueued directly on the controller so a push never blocks on a slow or absent reader
		const stream = new ReadableStream<Uint8Array>({
			start: (controller) => {
				this.controller = controller;
				controller.enqueue(encoder.encode(`event: endpoint\ndata: ${endpoint}\n\n`));
			},
			cancel: () => this.stop()
		});

		this.keepAlive = setInterval(() => this.enqueue(': keep-alive\n\n'), 15_000);

		return new Response(stream, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache, no-transform',
				Connection: 'keep-alive',
				'X-Accel-Buffering': 'no'
			}
		});
	}

	private enqueue(chunk: string): boolean {
		if (!this.controller) return false;

		try {
			this.controller.enqueue(encoder.encode(chunk));
			return true;
		} catch {
			this.stop();
			return false;
		}
	}

	private push(payload: string): Response {
		if (!this.controller) return new Response('No open stream', { status: 409 });
		if (!this.enqueue(`event: message\ndata: ${payload}\n\n`)) {
			return new Response('Stream closed', { status: 409 });
		}
		return new Response(null, { status: 202 });
	}

	private close(): Response {
		this.stop();
		return new Response(null, { status: 204 });
	}

	private stop(): void {
		if (this.keepAlive) clearInterval(this.keepAlive);
		this.keepAlive = undefined;

		try {
			this.controller?.close();
		} catch {
			// already closed or errored; nothing further to release
		}
		this.controller = undefined;
	}
}

export interface SseBinding {
	idFromName(name: string): DurableObjectId;
	get(id: DurableObjectId): DurableObjectStub;
}

/** the message endpoint a 2024-11-05 client posts to, announced on the stream */
export function messageEndpoint(base: URL, sessionId: string): string {
	const url = new URL(base.toString());
	url.pathname = url.pathname.replace(/\/sse\/?$/, '/messages');
	url.search = `?sessionId=${encodeURIComponent(sessionId)}`;
	return `${url.pathname}${url.search}`;
}

export async function openSseStream(binding: SseBinding, requestUrl: URL): Promise<Response> {
	const sessionId = crypto.randomUUID();
	const endpoint = messageEndpoint(requestUrl, sessionId);

	const stub = binding.get(binding.idFromName(sessionId));
	return stub.fetch(`https://session/open?endpoint=${encodeURIComponent(endpoint)}`);
}

export async function pushToSession(
	binding: SseBinding,
	sessionId: string,
	payload: unknown
): Promise<boolean> {
	const stub = binding.get(binding.idFromName(sessionId));
	const response = await stub.fetch('https://session/push', {
		method: 'POST',
		body: JSON.stringify(payload)
	});
	return response.ok || response.status === 202;
}

/** guidance returned when the deployment has no Durable Object to bridge the two halves */
export function sseUnavailable(mcpPath: string): Response {
	return new Response(
		JSON.stringify({
			jsonrpc: JSONRPC_VERSION,
			id: null,
			error: {
				code: -32601,
				message:
					'The 2024-11-05 HTTP+SSE transport needs the MCP_SSE Durable Object binding on this deployment. ' +
					`Use the Streamable HTTP endpoint at ${mcpPath} instead.`
			}
		}),
		{ status: 405, headers: { 'Content-Type': 'application/json', Allow: 'POST' } }
	);
}
