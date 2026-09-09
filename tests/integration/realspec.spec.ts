import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env';
import worker from '../../src/index';
import { clearToolTableCache } from '../../src/resolve';
import { ECHO, SPECS, mcpRequest, requireFixtures, rpcBody, rpcHeaders } from './fixtures';

/**
 * The unmodified Swagger Petstore description, fetched over real HTTP from the fixture server.
 * This exercises the whole pipeline on a document nobody wrote for these tests.
 */
const SPEC_URL = `http://${SPECS}/petstore.json`;
const MCP = mcpRequest(SPEC_URL);

const env: Env = { INSECURE_UPSTREAM_HOSTS: `${SPECS},${ECHO}` };
const ctx = {
	waitUntil: () => undefined,
	passThroughOnException: () => undefined
} as unknown as ExecutionContext;

async function rpc(
	method: string,
	params: Record<string, unknown> = {},
	name?: string
): Promise<any> {
	const response = await worker.fetch(
		new Request(MCP, {
			method: 'POST',
			headers: rpcHeaders(method, name),
			body: rpcBody(method, params)
		}),
		env,
		ctx
	);
	return response.json();
}

beforeAll(async () => {
	clearToolTableCache();
	await requireFixtures();
});

describe('the real Petstore description over real HTTP', () => {
	it('builds a tool per operation with client-safe names', async () => {
		const result = (await rpc('tools/list')).result;
		const names: string[] = result.tools.map((t: { name: string }) => t.name);

		expect(names.length).toBeGreaterThanOrEqual(19);
		expect(names).toContain('findPetsByStatus');
		expect(names).toContain('getPetById');
		expect(names).toContain('uploadFile');

		for (const name of names) expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
	});

	it('emits no dangling $ref in any tool schema', async () => {
		const result = (await rpc('tools/list')).result;

		for (const tool of result.tools) {
			const defs = tool.inputSchema.$defs ?? {};
			const refs: string[] = [];

			const walk = (node: unknown): void => {
				if (Array.isArray(node)) return node.forEach(walk);
				if (!node || typeof node !== 'object') return;
				for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
					if (key === '$ref' && typeof value === 'string') refs.push(value);
					else walk(value);
				}
			};
			walk({ ...tool.inputSchema, $defs: undefined });

			for (const ref of refs) {
				expect(ref.startsWith('#/$defs/')).toBe(true);
				expect(defs[ref.slice('#/$defs/'.length)]).toBeDefined();
			}
		}
	});

	it('resolves the relative servers entry against the description origin', async () => {
		const listed = (await rpc('resources/list')).result;
		const read = (
			await rpc('resources/read', { uri: listed.resources[0].uri }, listed.resources[0].uri)
		).result;

		expect(JSON.parse(read.contents[0].text).baseUrl).toBe(`http://${SPECS}/api/v3`);
	});

	it('reports the identity the description declares', async () => {
		const result = (await rpc('server/discover')).result;

		expect(result.resultType).toBe('complete');
		expect(result._meta['io.modelcontextprotocol/serverInfo'].name).toContain('Petstore');
		expect(result.supportedVersions).toContain('2026-07-28');
	});

	it('marks read and destructive operations in the annotations', async () => {
		const tools = (await rpc('tools/list')).result.tools as any[];

		const get = tools.find((t) => t.name === 'getPetById');
		const del = tools.find((t) => t.name === 'deletePet');

		expect(get.annotations.readOnlyHint).toBe(true);
		expect(del.annotations.destructiveHint).toBe(true);
	});

	it('derives an output schema from the described 2xx response', async () => {
		const tools = (await rpc('tools/list')).result.tools as any[];
		const find = tools.find((t) => t.name === 'findPetsByStatus');

		expect(find.outputSchema?.type).toBe('array');
	});

	it('filters a real description by tag', async () => {
		const response = await worker.fetch(
			new Request(`${MCP}?tags=user`, {
				method: 'POST',
				headers: rpcHeaders('tools/list'),
				body: rpcBody('tools/list')
			}),
			env,
			ctx
		);
		const tools = ((await response.json()) as any).result.tools as any[];

		expect(tools.length).toBeGreaterThan(0);
		expect(tools.every((t) => t.name.toLowerCase().includes('user'))).toBe(true);
	});

	it('builds the table faster once it is cached', async () => {
		clearToolTableCache();

		const coldStart = Date.now();
		await rpc('tools/list');
		const cold = Date.now() - coldStart;

		const warmStart = Date.now();
		await rpc('tools/list');
		const warm = Date.now() - warmStart;

		expect(cold).toBeLessThan(30_000);
		expect(warm).toBeLessThanOrEqual(cold);
	});
});
