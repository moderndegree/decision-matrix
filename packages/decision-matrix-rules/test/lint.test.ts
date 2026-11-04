import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ATTACK_TRIAGE_RULES, lintRuleset, traceRules, type AnswerView, type LintFinding } from '../src';

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

	it('points out a facts-only rule that comes too late to skip the server', () => {
		const policy = rules([rule('model', { all: [{ question: 'q', gte: 0.5 }] }), rule('facts', { all: [{ fact: 'ci', eq: true }] })]);
		assert.ok(codes(lintRuleset(policy)).includes('fact-rule-after-model-rule:facts'));
	});

	it('returns an invalid ruleset as one error instead of throwing', () => {
		assert.deepEqual(codes(lintRuleset({ version: 2 })), ['invalid']);
	});
});
