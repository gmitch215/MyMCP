import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const integration = process.env.INTEGRATION === '1';
const all = process.env.COVERAGE_ALL === '1';

const unitGlobs = ['tests/unit/**/*.spec.ts'];
const integrationGlobs = ['tests/integration/**/*.spec.ts'];

export default defineConfig({
	test: {
		include: all ? [...unitGlobs, ...integrationGlobs] : integration ? integrationGlobs : unitGlobs,
		testTimeout: integration || all ? 60000 : 15000,
		fileParallelism: !(integration || all),
		coverage: {
			provider: 'istanbul',
			reporter: ['text', 'clover', 'json'],
			include: ['src/**/*.ts'],
			exclude: ['tests/**']
		}
	},
	plugins: [
		cloudflareTest({
			remoteBindings: false,
			wrangler: { configPath: './tests/wrangler.jsonc' },
			miniflare: {
				compatibilityDate: '2026-08-22',
				kvNamespaces: ['MYMCP_KV'],
				bindings: { STATE_SECRET: 'test-secret-value-for-sealing-state' }
			}
		})
	]
});
