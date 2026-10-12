import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { Env } from '../src/env';
import { ALIASES, loadSpec } from '../src/resolve';
import { buildToolTable } from '../src/openapi/tools';

const env: Env = { FETCH_TIMEOUT_MS: '60000' };

interface Sample {
	operationId: string;
	path: Record<string, string | number>;
	query?: Record<string, string>;
}

/** public read-only calls; each one is validated against the outputSchema the server advertises */
const SAMPLES: Sample[] = [
	{ operationId: 'getStatus', path: {} },
	{ operationId: 'getRoundPublicResults', path: { tournId: 38306, eventAbbr: 'LD', roundName: 1 } },
	{ operationId: 'getRoundPublicResults', path: { tournId: 38306, eventAbbr: 'LD', roundName: 9 } },
	{
		operationId: 'getRoundPublicResults',
		path: { tournId: 28053, eventAbbr: '1VPF', roundName: 5 }
	},
	{ operationId: 'getTournResultSets', path: { tournId: 37602 } },
	{ operationId: 'getTournResultSets', path: { tournId: 38306 } },
	{ operationId: 'getResultSet', path: { tournId: 38306, resultSetId: 450012 } },
	{ operationId: 'getResultSet', path: { tournId: 38306, resultSetId: 450016 } },
	{ operationId: 'getResultSet', path: { tournId: 35467, resultSetId: 394391 } },
	{ operationId: 'getTournInvite', path: { tournId: 41013 } },
	{ operationId: 'get_rest_tourns_tournId', path: { tournId: 38306 } },
	{ operationId: 'get_rest_tourns_tournId_rounds', path: { tournId: 38306 } },
	{ operationId: 'get_rest_tourns_tournId_schedule', path: { tournId: 38306 } },
	{ operationId: 'get_rest_tourns_tournId_files', path: { tournId: 38306 } },
	{ operationId: 'restCircuitsActive', path: {}, query: { country: 'US', limit: '3' } },
	{ operationId: 'get_pages_invite_upcoming', path: {}, query: { state: 'IL', limit: '3' } },
	{ operationId: 'get_pages_invite_nsdaCategories', path: {} }
];

async function main(): Promise<void> {
	const entry = ALIASES['tabroom']!;
	const { doc } = await loadSpec(entry.url, env);
	const table = buildToolTable(doc);
	const validator = new AjvJsonSchemaValidator();
	let failed = 0;

	for (const sample of SAMPLES) {
		const tool = table.tools.find((t) => t.name === sample.operationId);
		const label = `${sample.operationId} ${JSON.stringify(sample.path)}`;
		if (!tool) {
			console.log(`SKIP ${label}: no such tool`);
			continue;
		}

		let path = tool.path;
		for (const [key, value] of Object.entries(sample.path)) {
			path = path.replace(`{${key}}`, encodeURIComponent(String(value)));
		}
		const query = sample.query ? `?${new URLSearchParams(sample.query)}` : '';
		const response = await fetch(`${entry.url.replace(/\/$/, '')}${path}${query}`);
		if (!response.ok) {
			console.log(`SKIP ${label}: HTTP ${response.status}`);
			continue;
		}
		if (!tool.outputSchema) {
			console.log(`ok   ${label}: no outputSchema`);
			continue;
		}

		const body = await response.json();
		const result = validator.getValidator(tool.outputSchema)(body);
		if (result.valid) {
			console.log(`ok   ${label}`);
			continue;
		}
		failed++;
		console.log(`FAIL ${label}: ${String(result.errorMessage).slice(0, 300)}`);
	}

	console.log(`\n${failed} of ${SAMPLES.length} samples fail their advertised outputSchema`);
	if (failed > 0) process.exit(1);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
