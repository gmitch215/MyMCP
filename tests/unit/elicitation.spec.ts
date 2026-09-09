import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env';
import worker from '../../src/index';
import { clearToolTableCache } from '../../src/resolve';
import { stubFetch } from '../helpers';

const SPEC = JSON.stringify({
	openapi: '3.1.0',
	info: { title: 'Demo API', description: 'demo', version: '1.0.0' },
	servers: [{ url: 'https://api.demo.example/v1' }],
	paths: {
		'/pets/{petId}': {
			get: {
				operationId: 'getPet',
				parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
				responses: {}
			},
			delete: {
				operationId: 'deletePet',
				parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
				responses: {}
			}
		}
	}
});

const SPEC_URL = 'https://api.demo.example/openapi.json';
const BASE = `https://mymcp.test/${encodeURIComponent(SPEC_URL)}/mcp`;

const env: Env = { STATE_SECRET: 'test-secret' };
const ctx = {
	waitUntil: () => undefined,
	passThroughOnException: () => undefined
} as unknown as ExecutionContext;

function callTool(
	name: string,
	params: Record<string, unknown>,
	capabilities: Record<string, unknown>,
	url = BASE
): Promise<Response> {
	const body = JSON.stringify({
		jsonrpc: '2.0',
		id: 1,
		method: 'tools/call',
		params: {
			name,
			...params,
			_meta: {
				'io.modelcontextprotocol/protocolVersion': '2026-07-28',
				'io.modelcontextprotocol/clientCapabilities': capabilities
			}
		}
	});

	return worker.fetch(
		new Request(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'MCP-Protocol-Version': '2026-07-28',
				'Mcp-Method': 'tools/call',
				'Mcp-Name': name
			},
			body
		}),
		env,
		ctx
	);
}

beforeEach(() => {
	clearToolTableCache();
	stubFetch({
		[SPEC_URL]: { body: SPEC },
		'https://api.demo.example/v1/pets/7': { body: '{"id":7}' }
	});
});
afterEach(() => clearToolTableCache());

describe('missing argument elicitation', () => {
	it('asks for a missing required argument when the client supports forms', async () => {
		const response = await callTool('getPet', { arguments: {} }, { elicitation: { form: {} } });
		const body = (await response.json()) as any;

		expect(body.result.resultType).toBe('input_required');
		expect(body.result.inputRequests.arguments.method).toBe('elicitation/create');
		expect(
			body.result.inputRequests.arguments.params.requestedSchema.properties.petId
		).toBeDefined();
		expect(typeof body.result.requestState).toBe('string');
	});

	it('completes the call when the client answers the elicitation', async () => {
		const first = (await (
			await callTool('getPet', { arguments: {} }, { elicitation: { form: {} } })
		).json()) as any;

		const second = (await (
			await callTool(
				'getPet',
				{
					arguments: {},
					requestState: first.result.requestState,
					inputResponses: { arguments: { action: 'accept', content: { petId: '7' } } }
				},
				{ elicitation: { form: {} } }
			)
		).json()) as any;

		expect(second.result.resultType).toBe('complete');
		expect(second.result.content[0].text).toBe('{"id":7}');
	});

	it('stops when the user declines', async () => {
		const first = (await (
			await callTool('getPet', { arguments: {} }, { elicitation: { form: {} } })
		).json()) as any;

		const second = (await (
			await callTool(
				'getPet',
				{
					arguments: {},
					requestState: first.result.requestState,
					inputResponses: { arguments: { action: 'decline' } }
				},
				{ elicitation: { form: {} } }
			)
		).json()) as any;

		expect(second.result.isError).toBe(true);
		expect(second.result.content[0].text).toContain('cancelled');
	});

	it('rejects tampered request state', async () => {
		const first = (await (
			await callTool('getPet', { arguments: {} }, { elicitation: { form: {} } })
		).json()) as any;

		const tampered = `${String(first.result.requestState).slice(0, -4)}AAAA`;
		const second = (await (
			await callTool(
				'getPet',
				{
					arguments: {},
					requestState: tampered,
					inputResponses: { arguments: { action: 'accept', content: { petId: '7' } } }
				},
				{ elicitation: { form: {} } }
			)
		).json()) as any;

		expect(second.error.code).toBe(-32602);
		expect(second.error.message).toContain('expired');
	});

	it('rejects state minted for a different tool', async () => {
		const first = (await (
			await callTool('getPet', { arguments: {} }, { elicitation: { form: {} } })
		).json()) as any;

		const second = (await (
			await callTool(
				'deletePet',
				{
					arguments: { petId: '7' },
					requestState: first.result.requestState
				},
				{ elicitation: { form: {} } }
			)
		).json()) as any;

		expect(second.error.code).toBe(-32602);
	});

	it('returns a plain tool error when the client cannot elicit', async () => {
		const body = (await (await callTool('getPet', { arguments: {} }, {})).json()) as any;

		expect(body.result.isError).toBe(true);
		expect(body.result.content[0].text).toContain('Missing required argument');
		expect(body.result.resultType).toBe('complete');
	});
});

describe('write confirmation', () => {
	const confirmUrl = `${BASE}?confirm=write`;

	it('asks for confirmation before a destructive call', async () => {
		const body = (await (
			await callTool(
				'deletePet',
				{ arguments: { petId: '7' } },
				{ elicitation: { form: {} } },
				confirmUrl
			)
		).json()) as any;

		expect(body.result.resultType).toBe('input_required');
		expect(
			body.result.inputRequests.confirm.params.requestedSchema.properties.confirm
		).toBeDefined();
	});

	it('does not ask when confirmation is off', async () => {
		stubFetch({
			[SPEC_URL]: { body: SPEC },
			'https://api.demo.example/v1/pets/7': { body: '{"deleted":true}' }
		});

		const body = (await (
			await callTool('deletePet', { arguments: { petId: '7' } }, { elicitation: { form: {} } })
		).json()) as any;

		expect(body.result.resultType).toBe('complete');
	});

	it('proceeds once the user confirms', async () => {
		stubFetch({
			[SPEC_URL]: { body: SPEC },
			'https://api.demo.example/v1/pets/7': { body: '{"deleted":true}' }
		});

		const first = (await (
			await callTool(
				'deletePet',
				{ arguments: { petId: '7' } },
				{ elicitation: { form: {} } },
				confirmUrl
			)
		).json()) as any;

		const second = (await (
			await callTool(
				'deletePet',
				{
					arguments: { petId: '7' },
					requestState: first.result.requestState,
					inputResponses: { confirm: { action: 'accept', content: { confirm: true } } }
				},
				{ elicitation: { form: {} } },
				confirmUrl
			)
		).json()) as any;

		expect(second.result.resultType).toBe('complete');
		expect(second.result.content[0].text).toBe('{"deleted":true}');
	});

	it('does nothing when the user does not confirm', async () => {
		const first = (await (
			await callTool(
				'deletePet',
				{ arguments: { petId: '7' } },
				{ elicitation: { form: {} } },
				confirmUrl
			)
		).json()) as any;

		const second = (await (
			await callTool(
				'deletePet',
				{
					arguments: { petId: '7' },
					requestState: first.result.requestState,
					inputResponses: { confirm: { action: 'accept', content: { confirm: false } } }
				},
				{ elicitation: { form: {} } },
				confirmUrl
			)
		).json()) as any;

		expect(second.result.isError).toBe(true);
		expect(second.result.content[0].text).toContain('not confirmed');
	});
});
