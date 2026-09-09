export const ECHO = '127.0.0.1:18081';
export const SPECS = '127.0.0.1:18082';

export function mcpRequest(specUrl: string): string {
	return `https://mymcp.test/${encodeURIComponent(specUrl)}/mcp`;
}

export function rpcHeaders(
	method: string,
	name?: string,
	extra: Record<string, string> = {}
): Record<string, string> {
	return {
		'Content-Type': 'application/json',
		Accept: 'application/json, text/event-stream',
		'MCP-Protocol-Version': '2026-07-28',
		'Mcp-Method': method,
		...(name ? { 'Mcp-Name': name } : {}),
		...extra
	};
}

export function rpcBody(
	method: string,
	params: Record<string, unknown> = {},
	id: number | string = 1
): string {
	return JSON.stringify({
		jsonrpc: '2.0',
		id,
		method,
		params: {
			...params,
			_meta: {
				'io.modelcontextprotocol/protocolVersion': '2026-07-28',
				'io.modelcontextprotocol/clientInfo': { name: 'integration', version: '1.0.0' },
				'io.modelcontextprotocol/clientCapabilities': {}
			}
		}
	});
}

/** fails loudly rather than mysteriously when the fixture stack is not running */
export async function requireFixtures(): Promise<void> {
	const checks: [string, string][] = [
		[`http://${ECHO}/status/200`, 'echo'],
		[`http://${SPECS}/petstore.json`, 'specs']
	];

	for (const [url, name] of checks) {
		const response = await fetch(url).catch(() => undefined);
		if (!response?.ok) {
			throw new Error(
				`The ${name} fixture is not reachable at ${url}. Run: docker compose -f docker/compose.yml up -d --wait`
			);
		}
	}
}
