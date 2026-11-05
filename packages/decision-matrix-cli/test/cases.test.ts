import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ACCESS_REVIEW_RULES, CI_CHANGE_RULES } from 'decision-matrix-rules';

import { EXIT_ERROR, EXIT_OK, factErrorGaps, readCases, run, runCases, uncovered, formatWhy } from '../src';
import { captured, readExample, rule, rules } from './fixtures';

describe('policy cases', () => {
	it('merges defaults under each case', () => {
		const cases = readCases({
			version: 1,
			defaults: { facts: { a: 1, nested: { x: 1, y: 2 } }, answers: { q: { noul: 0.1 } }, thresholds: { t: 1 } },
			cases: [{ name: 'one', facts: { nested: { y: 3 } }, answers: { r: { noul: 0.2 } }, expect: { gate: true } }],
		});
		assert.deepEqual(cases[0]?.facts, { a: 1, nested: { x: 1, y: 3 } });
		assert.deepEqual(Object.keys(cases[0]?.answers ?? {}), ['q', 'r']);
		assert.equal(cases[0]?.answers?.q?.type, 'noul');
		assert.deepEqual(cases[0]?.thresholds, { t: 1 });
	});

	it('rejects malformed files with the path', () => {
		assert.throws(() => readCases({ cases: [] }), /must be \{ "version": 1/);
		assert.throws(() => readCases({ version: 1, cases: [], extra: 1 }), /unknown key "extra"/);
		assert.throws(() => readCases({ version: 1, cases: [{ name: 'a', expect: {} }] }), /expect must name at least one/);
		assert.throws(() => readCases({ version: 1, cases: [{ name: 'a', expect: { gates: true } }] }), /unknown key "gates"/);
		assert.throws(
			() => readCases({ version: 1, cases: [{ name: 'a', expect: { gate: true } }, { name: 'a', expect: { gate: true } }] }),
			/duplicates "a"/,
		);
	});

	it('passes, fails, and expects errors', () => {
		const policy = rules([rule('ci', { all: [{ fact: 'ci', eq: true }] }), rule('injected', { all: [{ question: 'q', gte: 'high' }] })]);
		const run = runCases(
			policy,
			readCases({
				version: 1,
				cases: [
					{ name: 'facts decide', facts: { ci: true }, expect: { matched_rule: 'ci', from_facts: true } },
					{ name: 'wrong', facts: { ci: false }, answers: { q: { noul: 0.5 } }, expect: { matched_rule: 'injected' } },
					{ name: 'missing fact fails closed', expect: { error: 'fact "ci", which is missing' } },
				],
			}),
		);
		assert.deepEqual(
			run.results.map((result) => result.passed),
			[true, false, true],
		);
		assert.deepEqual(run.results[1]?.failures, ['matched_rule: expected "injected", got null']);
		assert.deepEqual(uncovered(run), ['injected']);
		const why = formatWhy(run.results[1]!.trace!);
		assert.match(why.join('\n'), /injected\s+no\s+q is 0.5, needs gte high \(0.8\)/);
		assert.match(why[why.length - 1]!, /default\s+match/);
	});

	it('names later matches that did not apply and stops before the default', () => {
		const policy = rules([rule('first', { all: [{ fact: 'a', eq: true }] }), rule('second', { all: [{ fact: 'b', eq: true }] })]);
		const run = runCases(
			policy,
			readCases({
				version: 1,
				cases: [{ name: 'both', facts: { a: true, b: true }, expect: { matched_rule: 'second' } }],
			}),
		);
		const why = formatWhy(run.results[0]!.trace!).join('\n');
		assert.match(why, /second\s+match\s+\(did not apply\)/);
		assert.doesNotMatch(why, /default\s+match/);
	});

	it('ships cases that pass and cover every rule of both strict presets', () => {
		for (const [name, policy] of [
			['ci-change', CI_CHANGE_RULES],
			['access-review', ACCESS_REVIEW_RULES],
		] as const) {
			const cases = readCases(JSON.parse(readExample(`${name}.cases.json`)));
			const run = runCases(policy, cases);
			assert.deepEqual(
				run.results.filter((result) => !result.passed).map((result) => result.name),
				[],
				name,
			);
			assert.deepEqual(uncovered(run), [], name);
			assert.deepEqual(factErrorGaps(policy, cases, run.results), [], name);
		}
	});
});

describe('decision-matrix test and check', () => {
	const cases = { 'cases.json': readExample('ci-change.cases.json') };

	it('test exits 0 when cases pass and 1 when a weakened policy breaks one', async () => {
		const ok = captured(
			['test', '--preset', 'ci-change', '--cases', 'cases.json', '--require-coverage', '--require-fact-errors'],
			cases,
		);
		assert.equal(await run(ok.io), EXIT_OK);
		assert.match(ok.stdout.join(''), /36 passed, 0 failed/);

		const weak = captured(['test', '--preset', 'ci-change', '--cases', 'cases.json', '--threshold', 'injection=0.9'], cases);
		assert.equal(await run(weak.io), EXIT_ERROR);
		assert.match(weak.stdout.join(''), /✗ text addressing the reviewer is blocked/);
	});

	it('test fails on coverage only when asked', async () => {
		const files = {
			'one.json': JSON.stringify({ version: 1, cases: [{ name: 'ci', facts: { ...JSON.parse(readExample('ci-change.cases.json')).defaults.facts, touches_ci: true }, expect: { gate: true } }] }),
		};
		assert.equal(await run(captured(['test', '--preset', 'ci-change', '--cases', 'one.json'], files).io), EXIT_OK);
		const strict = captured(['test', '--preset', 'ci-change', '--cases', 'one.json', '--require-coverage'], files);
		assert.equal(await run(strict.io), EXIT_ERROR);
		assert.match(strict.stdout.join(''), /Rules no case matches: hold-package-scripts/);
	});

	it('test --json prints machine-readable results', async () => {
		const { io, stdout } = captured(['test', '--preset', 'ci-change', '--cases', 'cases.json', '--json'], cases);
		assert.equal(await run(io), EXIT_OK);
		const parsed = JSON.parse(stdout.join(''));
		assert.equal(parsed.passed, true);
		assert.equal(parsed.results.length, 36);
	});

	it('check fails on errors always and on warnings with --strict', async () => {
		assert.equal(await run(captured(['check', '--preset', 'ci-change']).io), EXIT_OK);
		assert.equal(await run(captured(['check', '--preset', 'attack-triage']).io), EXIT_OK);
		const strict = captured(['check', '--preset', 'attack-triage', '--strict']);
		assert.equal(await run(strict.io), EXIT_ERROR);
		assert.match(strict.stdout.join(''), /model-opens-gate \[allow-legitimate\]/);
		const typo = captured(['check', '--rules', 'r.json', '--questions', 'q.json'], {
			'r.json': JSON.stringify(rules([rule('r', { all: [{ question: 'kind', eq: 'Bug' }] })])),
			'q.json': JSON.stringify({ kind: { type: 'choice', criteria: { bug: 'b' } } }),
		});
		assert.equal(await run(typo.io), EXIT_ERROR);
		assert.match(typo.stdout.join(''), /unknown-label \[r\]/);
	});

	it('requires an explicit ruleset and rejects flags a command does not use', async () => {
		const noRules = captured(['test', '--cases', 'cases.json'], cases);
		assert.equal(await run(noRules.io), EXIT_ERROR);
		assert.match(noRules.stderr.join(''), /test needs --rules <file> or --preset <name>/);
		const wrongFlag = captured(['test', '--preset', 'ci-change', '--cases', 'cases.json', '--server', 'http://x']);
		assert.equal(await run(wrongFlag.io), EXIT_ERROR);
		assert.match(wrongFlag.stderr.join(''), /test does not use --server/);
		const checkCases = captured(['check', '--preset', 'ci-change', '--cases', 'cases.json']);
		assert.equal(await run(checkCases.io), EXIT_ERROR);
		assert.match(checkCases.stderr.join(''), /check does not use --cases/);
	});
});
