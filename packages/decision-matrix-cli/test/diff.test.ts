import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CI_CHANGE_RULES } from 'decision-matrix-rules';

import { EXIT_GATE, EXIT_OK, diffPolicies, readCases, run } from '../src';
import { captured, readExample } from './fixtures';

function weakened() {
	const rules = JSON.parse(JSON.stringify(CI_CHANGE_RULES)) as typeof CI_CHANGE_RULES;
	rules.thresholds.injection = 0.9;
	return rules;
}

describe('decision-matrix diff', () => {
	const cases = readCases(JSON.parse(readExample('ci-change.cases.json')));

	it('lists the cases whose decision changes, and flags the ones that now open the gate', () => {
		const diff = diffPolicies(CI_CHANGE_RULES, weakened(), cases);
		assert.equal(diff.loosens, true);
		assert.deepEqual(
			diff.cases.map((change) => [change.name, change.after.decision?.matched_rule, change.opens]),
			[
				['text addressing the reviewer is blocked even when every other answer passes', 'pass-small-change', true],
				['a hint of injection at the threshold is enough', 'pass-small-change', true],
			],
		);
	});

	it('exits 2 with --fail-on-loosen and 0 for a change that only tightens', async () => {
		const files = {
			'old.json': JSON.stringify(CI_CHANGE_RULES),
			'weak.json': JSON.stringify(weakened()),
			'strict.json': JSON.stringify({ ...CI_CHANGE_RULES, thresholds: { ...CI_CHANGE_RULES.thresholds, injection: 0.3 } }),
			'cases.json': readExample('ci-change.cases.json'),
		};
		const weak = captured(['diff', '--from', 'old.json', '--to', 'weak.json', '--cases', 'cases.json', '--fail-on-loosen'], files);
		assert.equal(await run(weak.io), EXIT_GATE);
		assert.match(weak.stdout.join(''), /Loosens \(1\)/);
		assert.match(weak.stdout.join(''), /\[now opens the gate\]/);

		const strict = captured(['diff', '--from', 'old.json', '--to', 'strict.json', '--fail-on-loosen'], files);
		assert.equal(await run(strict.io), EXIT_OK);
		assert.match(strict.stdout.join(''), /Tightens \(1\)/);
	});

	it('prints markdown for a PR comment', async () => {
		const files = { 'a.json': JSON.stringify(CI_CHANGE_RULES), 'b.json': JSON.stringify(weakened()) };
		const { io, stdout } = captured(['diff', '--from', 'a.json', '--to', 'b.json', '--format', 'markdown'], files);
		assert.equal(await run(io), EXIT_OK);
		assert.match(stdout.join(''), /^## Policy diff: `a.json` → `b.json`/);
		assert.match(stdout.join(''), /### Loosens \(1\)\n- "hold-injection"/);
	});
});
