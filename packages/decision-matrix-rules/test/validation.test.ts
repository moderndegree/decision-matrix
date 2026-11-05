import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	RulesError,
	assertThresholdsResolve,
	bestEffortConfidence,
	compileFlatRows,
	evaluateRules,
	validateFacts,
	validateRuleset,
	type AnswerView,
	type FlatRow,
} from '../src';

const hold = { type: 'hold', target: 'human', reason: 'No matching rule', gate: true };
const pass = { type: 'pass', target: 't', reason: 'ok', gate: false };

function policy(extra: Record<string, unknown> = {}) {
	return { version: 1, default_action: hold, rules: [], ...extra };
}

function withWhen(when: unknown, extra: Record<string, unknown> = {}) {
	return policy({ rules: [{ id: 'r', when, action: hold }], ...extra });
}

function rejects(run: () => unknown, message: RegExp) {
	assert.throws(run, (error: unknown) => {
		assert.ok(error instanceof RulesError, `expected RulesError, got ${String(error)}`);
		assert.match(error.message, message);
		return true;
	});
}

describe('validateRuleset rejects', () => {
	const cases: Array<[string, unknown, RegExp]> = [
		['a rule that is not an object', policy({ rules: ['nope'] }), /rules\[0\] must be an object with id, when, and action/],
		['a rule id with spaces', policy({ rules: [{ id: 'a b', when: { fact: 'x', eq: 1 }, action: hold }] }), /id must be a non-empty string without spaces/],
		['a blank rule id', policy({ rules: [{ id: ' ', when: { fact: 'x', eq: 1 }, action: hold }] }), /id must be a non-empty string/],
		[
			'a duplicate rule id',
			policy({
				rules: [
					{ id: 'a', when: { fact: 'x', eq: 1 }, action: hold },
					{ id: 'a', when: { fact: 'x', eq: 2 }, action: hold },
				],
			}),
			/duplicates "a"/,
		],
		['a non-string description', policy({ rules: [{ id: 'a', description: 1, when: { fact: 'x', eq: 1 }, action: hold }] }), /description must be a string/],
		['a rule with no when', policy({ rules: [{ id: 'a', action: hold }] }), /when is required/],
		['a when that is not an object', withWhen('x'), /must be an object with "all", "any", "question", or "fact"/],
		['a fact path that is not a string', withWhen({ fact: 1, eq: 1 }), /fact must be a fact path/],
		['an empty fact path', withWhen({ fact: '', eq: 1 }), /fact must be a fact path/],
		['confidence on a fact', withWhen({ fact: 'x', confidence_gte: 0.5 }), /A fact is verified by the host and has no confidence/],
		['an empty in list on a question', withWhen({ question: 'q', in: [] }), /must be a non-empty array of choice labels/],
		['an in value that is not a list', withWhen({ question: 'q', in: 'a' }), /must be a non-empty array of choice labels/],
		['a threshold ref with an extra key', withWhen({ question: 'q', gte: { threshold: 'a', extra: 1 } }), /unknown key "extra"/],
		['a threshold ref that is not a string', withWhen({ question: 'q', gte: { threshold: 1 } }), /threshold must be a threshold name/],
		['a threshold ref with a bad name', withWhen({ question: 'q', gte: { threshold: '1bad' } }), /must start with a letter or underscore/],
		['a reserved threshold ref', withWhen({ question: 'q', gte: { threshold: '__proto__' } }), /must start with a letter or underscore/],
		['a thresholds block that is not an object', policy({ thresholds: [] }), /rules\.thresholds must be an object/],
		['a non-finite threshold', policy({ thresholds: { a: Number.POSITIVE_INFINITY } }), /rules\.thresholds\.a must be a finite number/],
		['a string threshold', policy({ thresholds: { a: '1' } }), /rules\.thresholds\.a must be a finite number/],
		['a fact_schema that is not an object', policy({ fact_schema: [] }), /rules\.fact_schema must be an object of fact paths/],
		['a bad fact_schema key', policy({ fact_schema: { '1 bad': { type: 'string', required: true } } }), /is not a fact path/],
		['a reserved fact_schema segment', policy({ fact_schema: { 'a.constructor': { type: 'string', required: true } } }), /is not a fact path/],
		['a fact_schema entry that is not an object', policy({ fact_schema: { a: 'string' } }), /must be an object with type and required/],
		['a fact_schema entry with an extra key', policy({ fact_schema: { a: { type: 'string', required: true, x: 1 } } }), /unknown key "x"/],
		['an unknown fact type', policy({ fact_schema: { a: { type: 'date', required: true } } }), /type must be one of/],
		['a fact_schema required that is not a boolean', policy({ fact_schema: { a: { type: 'string', required: 'yes' } } }), /required must be a boolean/],
		['agreements that are not a list', policy({ agreements: {} }), /rules\.agreements must be an array/],
		['an agreement that is not an object', policy({ agreements: ['a'] }), /rules\.agreements\[0\] must be an object/],
		['an agreement with an extra key', policy({ agreements: [{ question: 'q', fact: 'f', relation: 'eq', x: 1 }] }), /unknown key "x"/],
		['an agreement question with spaces', policy({ agreements: [{ question: 'a b', fact: 'f', relation: 'eq' }] }), /question must be a non-empty question id/],
		['an agreement fact that is not a string', policy({ agreements: [{ question: 'q', fact: 1, relation: 'eq' }] }), /fact must be a fact path/],
		['an agreement fact with a bad path', policy({ agreements: [{ question: 'q', fact: 'a..b', relation: 'eq' }] }), /is not a fact path/],
		['an unknown agreement relation', policy({ agreements: [{ question: 'q', fact: 'f', relation: 'implies' }] }), /relation must be "eq" or "inverse"/],
	];
	for (const [name, input, message] of cases) {
		it(name, () => rejects(() => validateRuleset(input), message));
	}

	it('conditions nested past the depth limit', () => {
		let when: unknown = { fact: 'x', eq: 1 };
		for (let i = 0; i < 64; i++) when = { all: [when] };
		rejects(() => validateRuleset(withWhen(when)), /nests conditions more than \d+ levels deep/);
	});
});

describe('evaluateRules with hand-built answers', () => {
	const gteRule = withWhen({ question: 'q', gte: 0.5 });
	const eqRule = withWhen({ question: 'q', eq: 'a' });

	it('rejects a numeric comparison on a noul or score with no value', () => {
		rejects(() => evaluateRules(gteRule, { q: { type: 'noul' } }), /is a noul answer with no numeric noul value/);
		rejects(() => evaluateRules(gteRule, { q: { type: 'score' } }), /is a score answer with no numeric score value/);
	});

	it('rejects eq on a non-choice answer and a choice with no value', () => {
		rejects(() => evaluateRules(eqRule, { q: { type: 'noul', noul: 1 } }), /is a noul answer\. eq, neq, in, and not_in apply to choice answers/);
		rejects(() => evaluateRules(eqRule, { q: { type: 'choice' } }), /is a choice answer with no choice value/);
	});

	it('rejects answers that are not a map of normalized answers', () => {
		rejects(() => evaluateRules(gteRule, [] as never), /Answers must be an object keyed by question name/);
		rejects(() => evaluateRules(gteRule, { q: { type: 'other' } as never }), /Answer "q" must be a normalized choice, noul, or score/);
		rejects(() => evaluateRules(gteRule, { q: null as never }), /Answer "q" must be a normalized/);
	});

	it('compares all four ordering operators at the boundary', () => {
		const at = (op: string) => evaluateRules(withWhen({ question: 'q', [op]: 0.5 }), { q: { type: 'noul', noul: 0.5 } }).matched_rule;
		assert.equal(at('gte'), 'r');
		assert.equal(at('lte'), 'r');
		assert.equal(at('gt'), null);
		assert.equal(at('lt'), null);
	});
});

describe('threshold overrides', () => {
	const rules = withWhen({ question: 'q', gte: { threshold: 'high' } }, { thresholds: { high: 0.8 } });

	it('override the ruleset value for this evaluation only', () => {
		const q: AnswerView = { type: 'noul', noul: 0.6 };
		assert.equal(evaluateRules(rules, { q }).matched_rule, null);
		assert.equal(evaluateRules(rules, { q }, { high: 0.5 }).matched_rule, 'r');
		assert.equal(evaluateRules(rules, { q }).matched_rule, null);
	});

	it('reject a non-object, a bad name, and a non-finite value', () => {
		const q: AnswerView = { type: 'noul', noul: 0.6 };
		rejects(() => evaluateRules(rules, { q }, [] as never), /Threshold overrides must be an object/);
		rejects(() => evaluateRules(rules, { q }, { 'bad name': 1 }), /Threshold override "bad name"/);
		rejects(() => evaluateRules(rules, { q }, { high: Number.NaN }), /Threshold override "high" must be a finite number/);
		rejects(() => evaluateRules(rules, { q }, { high: '0.1' as never }), /Threshold override "high" must be a finite number/);
	});

	it('name the defined thresholds when a reference does not resolve', () => {
		const none = withWhen({ question: 'q', gte: { threshold: 'missing' } });
		rejects(() => assertThresholdsResolve(none), /Threshold "missing" is referenced[\s\S]*Defined thresholds: \(none\)/);
		const some = withWhen({ question: 'q', gte: { threshold: 'missing' } }, { thresholds: { a: 1, b: 2 } });
		rejects(() => assertThresholdsResolve(some), /Defined thresholds: a, b/);
	});

	it('do not resolve a threshold through the prototype chain', () => {
		const inherited = withWhen({ question: 'q', gte: { threshold: 'toString' } });
		rejects(() => assertThresholdsResolve(inherited), /Threshold "toString" is referenced/);
	});
});

describe('bestEffortConfidence', () => {
	it('prefers the server confidence, then the selected probability', () => {
		assert.equal(bestEffortConfidence({ type: 'choice', choice: 'a', confidence: 0.4, probabilities: { a: 0.9 } }), 0.4);
		assert.equal(bestEffortConfidence({ type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.1 } }), 0.9);
		assert.equal(bestEffortConfidence({ type: 'score', score: 2, probabilities: { '1': 0.3, '2': 0.7 } }), 0.7);
	});

	it('does not fall back to the highest probability for a missing label', () => {
		assert.equal(bestEffortConfidence({ type: 'choice', choice: 'c', probabilities: { a: 0.9 } }), undefined);
		assert.equal(bestEffortConfidence({ type: 'score', score: 3, probabilities: { '1': 0.9 } }), undefined);
	});

	it('returns undefined with no signal, and uses decisiveness for noul', () => {
		assert.equal(bestEffortConfidence({ type: 'choice', choice: 'a' }), undefined);
		assert.equal(bestEffortConfidence({ type: 'choice', probabilities: { a: 1 } }), undefined);
		assert.equal(bestEffortConfidence({ type: 'score', probabilities: { '1': 1 } }), undefined);
		assert.equal(bestEffortConfidence({ type: 'noul', noul: 0.5 }), 0);
		assert.equal(bestEffortConfidence({ type: 'noul', noul: 0 }), 1);
	});
});

describe('validateFacts', () => {
	it('rejects a value that is not a fact, and names its path', () => {
		rejects(() => validateFacts({ a: { b: () => 1 } }), /Fact "a\.b" is .*Facts are strings, numbers, booleans, null/);
		rejects(() => validateFacts({ a: undefined }), /Fact "a" is /);
	});
});

describe('compileFlatRows rejects', () => {
	const action = pass;
	const cell = { source: 'fact', subject: 'x', operator: 'eq', value: 1 };
	const row = (extra: Record<string, unknown>) => ({ id: 'r', combine: 'all', conditions: [cell], action, ...extra });
	const cases: Array<[string, unknown, RegExp]> = [
		['rows that are not a list', {}, /Rule rows must be an array/],
		['a row that is not an object', ['x'], /Rule row 1 must be an object/],
		['a blank id', [row({ id: ' ' })], /Rule row 1 is missing an id/],
		['a nested combine', [row({ combine: 'nested' })], /combine must be "all" or "any"/],
		['no conditions', [row({ conditions: [] })], /needs at least one condition/],
		['no action', [row({ action: undefined })], /is missing an action/],
		['a cell that is a list', [row({ conditions: [[cell]] })], /must be one comparison/],
		['a cell with an extra key', [row({ conditions: [{ ...cell, all: [] }] })], /unknown key "all"/],
		['an unknown source', [row({ conditions: [{ ...cell, source: 'env' }] })], /source must be "fact" or "question"/],
		['a blank subject', [row({ conditions: [{ ...cell, subject: ' ' }] })], /is missing a subject/],
		['an unknown operator', [row({ conditions: [{ ...cell, operator: 'like' }] })], /has unknown operator "like"/],
		['a fact-only operator on a question', [row({ conditions: [{ ...cell, source: 'question', operator: 'contains' }] })], /uses contains on a question/],
		['a question-only operator on a fact', [row({ conditions: [{ ...cell, operator: 'confidence_gte' }] })], /uses confidence_gte on a fact/],
		['in with a scalar', [row({ conditions: [{ ...cell, operator: 'in', value: 1 }] })], /in needs an array value/],
	];
	for (const [name, rows, message] of cases) {
		it(name, () => rejects(() => compileFlatRows(rows as FlatRow[]), message));
	}

	it('trims the id and subject', () => {
		const [compiled] = compileFlatRows([row({ id: ' r ', conditions: [{ ...cell, subject: ' x ' }] })] as unknown as FlatRow[]);
		assert.deepEqual(compiled, { id: 'r', when: { fact: 'x', eq: 1 }, action });
	});
});
