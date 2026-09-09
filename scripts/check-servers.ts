import type { Env } from '../src/env';
import { buildToolTable } from '../src/openapi/tools';
import { loadSpec } from '../src/resolve';
import servers from '../src/servers.json';

/** the same knobs the deployment has, so a cap can be tried here before it is configured */
const env: Env = {
	MAX_SPEC_BYTES: process.env.MAX_SPEC_BYTES,
	FETCH_TIMEOUT_MS: process.env.FETCH_TIMEOUT_MS ?? '60000'
};

/**
 * Validates every alias in servers.json: reachable, parses as a description, yields tools.
 *
 * A dead alias shipped once already (tabroom moved and the entry 404ed for months), so this runs
 * in CI on a schedule rather than depending on anyone remembering to check.
 */

interface Outcome {
	alias: string;
	url: string;
	ok: boolean;
	detail: string;
	tools?: number;
	ms: number;
}

const CONCURRENCY = 4;

async function check(alias: string, url: string): Promise<Outcome> {
	const started = Date.now();

	try {
		const { doc, sourceUrl } = await loadSpec(url, env);
		const table = buildToolTable(doc);
		const ms = Date.now() - started;

		if (table.tools.length === 0) {
			return { alias, url, ok: false, detail: 'parsed but produced no tools', tools: 0, ms };
		}

		const invalid = table.tools.filter((t) => !/^[A-Za-z0-9_-]{1,64}$/.test(t.name));
		if (invalid.length > 0) {
			return {
				alias,
				url,
				ok: false,
				detail: `${invalid.length} tool names are not client-safe, e.g. ${invalid[0]!.name}`,
				tools: table.tools.length,
				ms
			};
		}

		const via = sourceUrl === url ? '' : ` (via ${sourceUrl})`;
		return {
			alias,
			url,
			ok: true,
			detail: `${doc.openapi} "${table.serverInfo.name}"${via}`,
			tools: table.tools.length,
			ms
		};
	} catch (error) {
		return {
			alias,
			url,
			ok: false,
			detail: error instanceof Error ? error.message : String(error),
			ms: Date.now() - started
		};
	}
}

async function main(): Promise<void> {
	const entries = Object.entries(servers as Record<string, string>);
	const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
	const selected = only.length ? entries.filter(([alias]) => only.includes(alias)) : entries;

	console.log(
		`Checking ${selected.length} server${selected.length === 1 ? '' : 's'} from servers.json\n`
	);

	const results: Outcome[] = [];
	const queue = [...selected];

	await Promise.all(
		Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
			for (;;) {
				const next = queue.shift();
				if (!next) return;
				results.push(await check(next[0], next[1]));
			}
		})
	);

	results.sort((a, b) => a.alias.localeCompare(b.alias));

	for (const result of results) {
		const mark = result.ok ? 'ok  ' : 'FAIL';
		const tools =
			result.tools !== undefined ? `${String(result.tools).padStart(4)} tools` : '     -    ';
		console.log(
			`${mark} ${result.alias.padEnd(14)} ${tools}  ${String(result.ms).padStart(5)}ms  ${result.detail}`
		);
	}

	const failed = results.filter((r) => !r.ok);
	console.log(`\n${results.length - failed.length}/${results.length} passed`);

	if (failed.length > 0) {
		console.error(`\n${failed.length} alias${failed.length === 1 ? '' : 'es'} need attention:`);
		for (const result of failed) console.error(`  ${result.alias}: ${result.url}`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
