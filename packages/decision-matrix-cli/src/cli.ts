#!/usr/bin/env node
import { readFileFromDisk, run } from './run';

run({
	argv: process.argv.slice(2),
	env: process.env,
	stdinIsTTY: Boolean(process.stdin.isTTY),
	readStdin: readStdin,
	readFile: readFileFromDisk,
	stdout: (text) => {
		process.stdout.write(text);
	},
	stderr: (text) => {
		process.stderr.write(text);
	},
}).then(
	(code) => {
		process.exit(code);
	},
	(error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${message}\n`);
		process.exit(1);
	},
);

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString('utf8');
}
