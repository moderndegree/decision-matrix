import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const main = path.resolve(import.meta.dir, '../src/main.tsx');
const rules = path.resolve(import.meta.dir, '../../decision-matrix-cli/examples/ci-change.rules.json');

function run(...args: string[]) {
	return spawnSync(process.execPath, [main, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

describe('main', () => {
	test('--help prints usage and exits 0', () => {
		const result = run('--help');
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('decision-matrix-tui --rules <file>');
	});

	test('--rules is required', () => {
		const result = run();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('--rules <file> is required.');
	});

	test('an unknown flag fails', () => {
		const result = run('--nope');
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('--nope');
	});

	test('refuses to start without a terminal and points at the CLI', () => {
		const result = run('--rules', rules);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('decision-matrix-tui needs a terminal.');
	});
});
