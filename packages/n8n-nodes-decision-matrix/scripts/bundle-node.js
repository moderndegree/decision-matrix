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
		// decision-matrix-rules and decision-matrix-systemone resolve through the
		// workspace to their built dist/ and are bundled in, so installing this
		// package into n8n does not need them published.
		external: ['n8n-workflow'],
		logLevel: 'info',
	})
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
