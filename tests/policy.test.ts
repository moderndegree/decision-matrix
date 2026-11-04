import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
	ACCESS_REVIEW_RULES,
	ATTACK_TRIAGE_RULES,
	CI_CHANGE_RULES,
	lintRuleset,
	traceRules,
	type AnswerView,
	type LintFinding,
} from 'decision-matrix-rules';
import { ACCESS_REVIEW_QUESTIONS, CI_CHANGE_QUESTIONS, SUPPORT_OPS_QUESTIONS } from 'decision-matrix-systemone';
import { EXIT_ERROR, EXIT_OK, formatWhy, readCases, run, runCases, uncovered, type CliIO } from 'decision-matrix-cli';

const examples = path.resolve(__dirname, '..', 'packages/decision-matrix-cli/examples');
const readExample = (name: string) => readFileSync(path.join(examples, name), 'utf8');

const noul = (value: number): AnswerView => ({ type: 'noul', noul: value });

function rules(list: unknown[], extra: Record<string, unknown> = {}) {
	return {
		version: 1,
		default_action: { type: 'hold', target: 'human', reason: 'No matching rule', gate: true },
		thresholds: { high: 0.8 },
		rules: list,
		...extra,
	};
}

function rule(id: string, when: unknown, gate = true) {
	return { id, when, action: { type: gate ? 'hold' : 'pass', target: 't', reason: `Rule ${id}`, gate } };
}

const codes = (findings: LintFinding[]) => findings.map((finding) => `${finding.code}${finding.rule ? `:${finding.rule}` : ''}`);

describe('traceRules', () => {
	it('records each value and check, and agrees with evaluateRules', () => {
		const policy = rules([
			rule('facts', { all: [{ fact: 'ci', eq: true }] }),
			rule('model', { any: [{ question: 'q', gte: 'high' }, { fact: 'n', gt: 3 }] }),
		]);
		const trace = traceRules(policy, { q: noul(0.9) }, undefined, { ci: false, n: 1 });
		assert.equal(trace.decision?.matched_rule, 'model');
		const [facts, model] = trace.rules;
		assert.equal(facts?.matched, false);
		assert.deepEqual(facts?.when, {
			kind: 'all',
			matched: false,
			children: [{ kind: 'fact', fact: 'ci', value: false, matched: false, checks: [{ op: 'eq', expected: true, matched: false }] }],
		});
		assert.equal(model?.matched, true);
		const branch = model?.when?.kind === 'any' ? model.when.children[0] : undefined;
		assert.deepEqual(branch, {
			kind: 'question',
			question: 'q',
			value: 0.9,
			matched: true,
			checks: [{ op: 'gte', expected: 0.8, threshold: 'high', matched: true }],
		});
	});

	it('keeps tracing other rules when one cannot be evaluated', () => {
		const trace = traceRules(rules([rule('a', { all: [{ question: 'missing', gte: 0.5 }] }), rule('b', { all: [{ fact: 'x', eq: 1 }] })]), {}, undefined, { x: 1 });
		assert.match(trace.rules[0]?.error ?? '', /absent from the decision server answers/);
		assert.equal(trace.rules[1]?.matched, true);
		assert.match(trace.error ?? '', /absent/);
		assert.equal(trace.decision, undefined);
	});
});

describe('lintRuleset', () => {
	it('passes the strict presets cleanly with their questions', () => {
		assert.deepEqual(lintRuleset(CI_CHANGE_RULES, { questions: CI_CHANGE_QUESTIONS }), []);
		assert.deepEqual(lintRuleset(ACCESS_REVIEW_RULES, { questions: ACCESS_REVIEW_QUESTIONS }), []);
	});

	it('warns when the model alone can open the gate, or the default proceeds', () => {
		assert.deepEqual(codes(lintRuleset(ATTACK_TRIAGE_RULES)), ['model-opens-gate:allow-legitimate']);
		const open = rules([], { thresholds: {}, default_action: { type: 'pass', target: 't', reason: 'r', gate: false } });
		assert.deepEqual(codes(lintRuleset(open)), ['default-opens-gate']);
	});

	it('finds a rule an earlier rule always beats', () => {
		const policy = rules([
			rule('broad', { all: [{ question: 'risk', gte: 2 }] }),
			rule('narrow', { all: [{ question: 'risk', gte: 3 }, { fact: 'prod', eq: true }] }),
			rule('other-side', { all: [{ question: 'risk', lt: 2 }] }),
			rule('labels', { all: [{ question: 'kind', in: ['a', 'b'] }] }),
			rule('subset', { all: [{ question: 'kind', eq: 'a' }] }),
			rule('either', { any: [{ fact: 'x', eq: 1 }, { fact: 'y', eq: 1 }] }),
			rule('one-branch', { all: [{ fact: 'y', eq: 1 }, { fact: 'z', eq: 2 }] }),
			rule('maybe-y', { any: [{ fact: 'y', eq: 1 }, { fact: 'w', eq: 1 }] }),
		]);
		const shadowed = lintRuleset(policy).filter((finding) => finding.code === 'shadowed');
		assert.deepEqual(shadowed.map((finding) => finding.rule), ['narrow', 'subset', 'one-branch']);
		assert.match(shadowed[0]!.message, /"broad" comes first/);
	});

	it('does not call a rule shadowed when an earlier threshold is stricter', () => {
		const policy = rules([rule('strict', { all: [{ question: 'q', gt: 0.9 }] }), rule('loose', { all: [{ question: 'q', gte: 0.5 }] })]);
		assert.deepEqual(codes(lintRuleset(policy)).filter((code) => code.startsWith('shadowed')), []);
		const equal = rules([rule('gte', { all: [{ question: 'q', gte: 0.5 }] }), rule('gt', { all: [{ question: 'q', gt: 0.5 }] })]);
		assert.deepEqual(codes(lintRuleset(equal)).filter((code) => code.startsWith('shadowed')), ['shadowed:gt']);
	});

	it('checks question ids, operator types, labels, and ranges', () => {
		const questions = {
			kind: { type: 'choice', criteria: { bugfix: 'b', feature: 'f' } },
			risk: { type: 'score', criteria: ['0', '1', '2', '3'] },
			human: { type: 'noul' },
			unused: { type: 'noul' },
		};
		const policy = rules([
			rule('typo', { all: [{ question: 'kind', in: ['Bugfix'] }] }),
			rule('wrong-op', { all: [{ question: 'kind', gte: 1 }] }),
			rule('noul-confidence', { all: [{ question: 'human', confidence_gte: 0.5 }] }),
			rule('ghost', { all: [{ question: 'nope', gte: 0.5 }] }),
			rule('range', { all: [{ question: 'risk', gte: 7 }, { question: 'human', gte: 1.5 }] }),
		]);
		const found = codes(lintRuleset(policy, { questions }));
		for (const expected of [
			'unknown-label:typo',
			'operator-type:wrong-op',
			'operator-type:noul-confidence',
			'unknown-question:ghost',
			'out-of-range:range',
			'unused-question',
			'unused-threshold',
		]) {
			assert.ok(found.includes(expected), `${expected} in ${found.join(', ')}`);
		}
	});

	it('reports a question the support preset asks but never reads', () => {
		const findings = lintRuleset(
			JSON.parse(JSON.stringify({ ...rules([rule('a', { all: [{ question: 'severity', eq: 'sev1' }] })]), thresholds: {} })),
			{ questions: SUPPORT_OPS_QUESTIONS },
		);
		assert.deepEqual(
			findings.filter((finding) => finding.code === 'unused-question').map((finding) => finding.message.split('"')[1]),
			['customer_impact', 'page_oncall'],
		);
	});

	it('points out a facts-only rule that comes too late to skip the server', () => {
		const policy = rules([rule('model', { all: [{ question: 'q', gte: 0.5 }] }), rule('facts', { all: [{ fact: 'ci', eq: true }] })]);
		assert.ok(codes(lintRuleset(policy)).includes('fact-rule-after-model-rule:facts'));
	});

	it('returns an invalid ruleset as one error instead of throwing', () => {
		assert.deepEqual(codes(lintRuleset({ version: 2 })), ['invalid']);
	});
});

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

	it('ships cases that pass and cover every rule of both strict presets', () => {
		for (const [name, policy] of [
			['ci-change', CI_CHANGE_RULES],
			['access-review', ACCESS_REVIEW_RULES],
		] as const) {
			const run = runCases(policy, readCases(JSON.parse(readExample(`${name}.cases.json`))));
			assert.deepEqual(
				run.results.filter((result) => !result.passed).map((result) => result.name),
				[],
				name,
			);
			assert.deepEqual(uncovered(run), [], name);
		}
	});
});

function captured(argv: string[], files: Record<string, string> = {}) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const io: CliIO = {
		argv,
		env: {},
		stdinIsTTY: true,
		readStdin: async () => '',
		readFile: async (filePath) => {
			const text = files[filePath];
			if (text === undefined) throw new Error(`Could not read ${filePath}. missing`);
			return text;
		},
		stdout: (text) => stdout.push(text),
		stderr: (text) => stderr.push(text),
	};
	return { io, stdout, stderr };
}

describe('decision-matrix test and check', () => {
	const cases = { 'cases.json': readExample('ci-change.cases.json') };

	it('test exits 0 when cases pass and 1 when a weakened policy breaks one', async () => {
		const ok = captured(['test', '--preset', 'ci-change', '--cases', 'cases.json', '--require-coverage'], cases);
		assert.equal(await run(ok.io), EXIT_OK);
		assert.match(ok.stdout.join(''), /16 passed, 0 failed/);

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
		assert.equal(parsed.results.length, 16);
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
