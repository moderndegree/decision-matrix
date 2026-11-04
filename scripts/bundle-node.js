const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');

esbuild
	.build({
		entryPoints: {
			'nodes/DecisionMatrix/DecisionMatrix.node': path.join(
				root,
				'nodes/DecisionMatrix/DecisionMatrix.node.ts',
			),
			'credentials/DecisionServerApi.credentials': path.join(
				root,
				'credentials/DecisionServerApi.credentials.ts',
			),
		},
		outdir: path.join(root, 'dist'),
		bundle: true,
		platform: 'node',
		target: 'node20',
		format: 'cjs',
		sourcemap: true,
		external: ['n8n-workflow'],
		alias: {
			'decision-matrix-rules': path.join(root, 'packages/decision-matrix-rules/src/index.ts'),
			'decision-matrix-systemone': path.join(root, 'packages/decision-matrix-systemone/src/index.ts'),
		},
		logLevel: 'info',
	})
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
