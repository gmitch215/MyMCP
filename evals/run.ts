import { readFileSync } from 'node:fs';
import { buildToolTable } from '../src/openapi/tools';
import { normalizeSpec } from '../src/resolve';
import type { ToolDefinition } from '../src/types';
import { CASES, PASS_THRESHOLD } from './cases';
import type { EvalCase } from './cases';

/**
 * Scores whether a model can pick the right tool and fill its arguments from the schemas MyMCP
 * generates. Routed through the local Claude Code CLI rather than a hosted API.
 *
 * Run with: bun run evals
 */

const MODEL = process.env.EVAL_MODEL ?? 'sonnet';

interface Choice {
	tool?: string;
	arguments?: Record<string, unknown>;
}

const tableCache = new Map<string, ToolDefinition[]>();

function toolsFor(specPath: string): ToolDefinition[] {
	const cached = tableCache.get(specPath);
	if (cached) return cached;

	const doc = normalizeSpec(JSON.parse(readFileSync(specPath, 'utf8')));
	if (!doc) throw new Error(`Not an OpenAPI description: ${specPath}`);

	const tools = buildToolTable(doc).tools;
	tableCache.set(specPath, tools);
	return tools;
}

function buildPrompt(tools: ToolDefinition[], request: string): string {
	const catalogue = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema
	}));

	return [
		'You are choosing one tool to satisfy a user request.',
		'',
		'Available tools:',
		JSON.stringify(catalogue, null, 2),
		'',
		`User request: ${request}`,
		'',
		'Reply with ONLY a JSON object of the form {"tool": "<name>", "arguments": {...}}.',
		'Do not wrap it in a code fence and do not explain your choice.'
	].join('\n');
}

async function ask(prompt: string): Promise<Choice | undefined> {
	const proc = Bun.spawn(['claude', '-p', '--model', MODEL, prompt], {
		stdout: 'pipe',
		stderr: 'pipe'
	});

	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited
	]);

	if (code !== 0) {
		console.error(`  claude exited ${code}: ${stderr.trim().slice(0, 300)}`);
		return undefined;
	}

	const match = stdout.match(/\{[\s\S]*\}/);
	if (!match) return undefined;

	try {
		return JSON.parse(match[0]) as Choice;
	} catch {
		return undefined;
	}
}

function looselyEqual(actual: unknown, expected: unknown): boolean {
	if (actual === expected) return true;
	if (typeof expected === 'number') return Number(actual) === expected;
	if (typeof expected === 'string' && typeof actual === 'string') {
		return actual.toLowerCase() === expected.toLowerCase();
	}
	return false;
}

interface Result {
	testCase: EvalCase;
	passed: boolean;
	detail: string;
}

async function runCase(testCase: EvalCase): Promise<Result> {
	const tools = toolsFor(testCase.spec);
	const choice = await ask(buildPrompt(tools, testCase.prompt));

	if (!choice?.tool) return { testCase, passed: false, detail: 'no usable answer' };

	if (choice.tool !== testCase.expectTool) {
		return { testCase, passed: false, detail: `chose ${choice.tool}` };
	}

	const args = choice.arguments ?? {};

	for (const [name, expected] of Object.entries(testCase.expectArgs ?? {})) {
		if (!looselyEqual(args[name], expected)) {
			return {
				testCase,
				passed: false,
				detail: `${name} was ${JSON.stringify(args[name])}, expected ${JSON.stringify(expected)}`
			};
		}
	}

	for (const name of testCase.requireArgs ?? []) {
		if (args[name] === undefined) {
			return { testCase, passed: false, detail: `missing argument ${name}` };
		}
	}

	return { testCase, passed: true, detail: 'ok' };
}

async function main(): Promise<void> {
	console.log(
		`Running ${CASES.length} tool-selection evals against local Claude Code (${MODEL})\n`
	);

	const results: Result[] = [];
	for (const testCase of CASES) {
		const result = await runCase(testCase);
		results.push(result);

		const mark = result.passed ? 'pass' : 'FAIL';
		console.log(`${mark}  ${testCase.expectTool.padEnd(20)} ${testCase.prompt}`);
		if (!result.passed) console.log(`      ${result.detail}`);
	}

	const passed = results.filter((r) => r.passed).length;
	const score = passed / results.length;

	console.log(`\n${passed}/${results.length} passed (${(score * 100).toFixed(0)}%)`);
	console.log(`threshold ${(PASS_THRESHOLD * 100).toFixed(0)}%`);

	if (score < PASS_THRESHOLD) {
		console.error('\nBelow threshold: the generated tool schemas are not steering the model well.');
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
