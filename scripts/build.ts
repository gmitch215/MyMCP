// bundles the npm entry to dist/lib.js, then tsc emits the .d.ts tree
// run: bun run build
import { $ } from 'bun';
import { rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });

const result = await Bun.build({
	entrypoints: ['src/lib.ts'],
	outdir: 'dist',
	target: 'node',
	format: 'esm',
	sourcemap: 'linked',
	external: ['yaml']
});

if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}

await $`tsc -p tsconfig.build.json`;

console.log(`built ${result.outputs.length} files`);
