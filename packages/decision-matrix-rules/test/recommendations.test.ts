import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	CI_CHANGE_RULES,
	GENERIC_TRIAGE_RULES,
	RulesError,
	assertFactsResolve,
	bestEffortConfidence,
	compileFlatRows,
	decisionReceipt,
	evaluateRules,
	parseInstant,
	projectTable,
	questionsScriptsCannotOpen,
	rulesetHash,
	traceRules,
	validateRuleset,
	type AnswerView,
} from '../src';

function noul(value: number): AnswerView {
	return { type: 'noul', noul: value };
}

function hold(id: string, when: unknown, gate = true) {
	return {
		id,
		when,
		action: { type: gate ? 'hold' : 'pass', target: 't', reason: `Rule ${id}`, gate },
	};
}

function policy(rules: unknown[], extra: Record<string, unknown> = {}) {
	return {
		version: 1,
		default_action: { type: 'hold', target: 'human', reason: 'No matching rule', gate: true },
		rules,
		...extra,
	};
}

describe('fact schema and instants', () => {
	it('names the path and the received value when a declared type does not match', () => {
		const rules = policy([hold('r', { all: [{ fact: 'touches_ci', eq: true }] })], {
			fact_schema: { touches_ci: { type: 'boolean', required: true } },
		});
		assert.throws(
			() => evaluateRules(rules, {}, undefined, { touches_ci: 1 }),
			/Fact "touches_ci" is declared boolean\. Received 1\./,
		);
	});

	it('errors when a required fact no rule reads is missing', () => {
		const rules = policy([], { fact_schema: { owner: { type: 'string', required: true } } });
		assert.throws(() => assertFactsResolve(rules, {}), /fact_schema[\s\S]*fact "owner"/);
	});

	it('orders instants and refuses to mix them with numbers', () => {
		const later = policy([hold('later', { all: [{ fact: 'seen', gte: '2024-01-01T00:00:00Z' }] }, false)]);
		assert.equal(evaluateRules(later, {}, undefined, { seen: '2024-06-01T00:00:00Z' }).matched_rule, 'later');
		assert.equal(evaluateRules(later, {}, undefined, { seen: '2023-01-01T00:00:00Z' }).matched_rule, null);
		assert.throws(() => evaluateRules(later, {}, undefined, { seen: 1 }), /compares an instant with a number/);
		assert.throws(() => evaluateRules(later, {}, undefined, { seen: '2024-01-01' }), /needs an ISO-8601 instant/);
		const numeric = policy([hold('n', { all: [{ fact: 'count', gte: 1 }] })]);
		assert.throws(
			() => evaluateRules(numeric, {}, undefined, { count: '2024-01-01T00:00:00Z' }),
			/compares an instant fact with a number/,
		);
		assert.equal(parseInstant('2024-01-02T03:04:05Z'), parseInstant('2024-01-02T03:04:05+00:00'));
		assert.equal(parseInstant('2024-01-02T03:04:05.123456789Z'), parseInstant('2024-01-02T03:04:05.123Z'));
	});
});

describe('agreements and contributions', () => {
	const opening = (agreements: unknown) =>
		policy([hold('open', { all: [{ fact: 'ok', eq: true }] }, false)], { agreements });

	it('holds an opening decision when an inverse agreement disagrees', () => {
		const rules = opening([{ question: 'q', fact: 'docs_only', relation: 'inverse' }]);
		const agrees = evaluateRules(rules, { q: noul(0.9) }, undefined, { ok: true, docs_only: false });
		assert.equal(agrees.gate, false);
		assert.equal(agrees.reason, 'Rule open');
		const held = evaluateRules(rules, { q: noul(0.9) }, undefined, { ok: true, docs_only: true });
		assert.equal(held.gate, true);
		assert.equal(held.action, 'pass');
		assert.equal(held.matched_rule, 'open');
		assert.match(held.reason, /disagrees with fact "docs_only"/);
	});

	it('leaves a hold in place and does not hold an incomparable shape', () => {
		const holding = policy([hold('kept', { all: [{ fact: 'ok', eq: true }] })], {
			agreements: [{ question: 'q', fact: 'docs_only', relation: 'inverse' }],
		});
		const kept = evaluateRules(holding, { q: noul(0.9) }, undefined, { ok: true, docs_only: true });
		assert.equal(kept.gate, true);
		assert.equal(kept.reason, 'Rule kept');
		const arrayRules = opening([{ question: 'q', fact: 'tags', relation: 'eq' }]);
		const arrayDecision = evaluateRules(arrayRules, { q: noul(0.9) }, undefined, { ok: true, tags: ['a'] });
		assert.equal(arrayDecision.gate, false);
	});

	it('errors on a missing agreement fact only when the question was answered', () => {
		const rules = opening([{ question: 'q', fact: 'docs_only', relation: 'inverse' }]);
		const unanswered = evaluateRules(rules, {}, undefined, { ok: true });
		assert.equal(unanswered.gate, false);
		assert.equal(unanswered.matched_rule, 'open');
		assert.throws(
			() => evaluateRules(rules, { q: noul(0.9) }, undefined, { ok: true }),
			/Agreement on question "q"/,
		);
	});

	it('records a margin per question and satisfies only the matched branch', () => {
		const rules = policy([
			hold('win', { any: [{ question: 'q', gte: 0.8 }, { question: 'r', gte: 0.8 }] }, false),
		]);
		const decision = evaluateRules(rules, { q: noul(0.9), r: noul(0.1) });
		assert.equal(decision.confidence, 0.8);
		assert.equal(decision.margin, 0.8);
		assert.deepEqual(decision.contributions, [
			{ question: 'q', margin: 0.8, satisfied: true },
			{ question: 'r', margin: 0.8, satisfied: false },
		]);
		const factsOnly = evaluateRules(policy([hold('facts', { all: [{ fact: 'a', eq: true }] })]), {}, undefined, { a: true });
		assert.deepEqual(factsOnly.contributions, []);
		assert.equal(factsOnly.confidence, 1);
		assert.equal(factsOnly.margin, 1);
		const fallback = evaluateRules(policy([]), {});
		assert.deepEqual(fallback.contributions, []);
		assert.equal(fallback.margin, 0);
	});

	it('rejects a probability outside 0 to 1 and does not invent a missing label', () => {
		assert.throws(() => evaluateRules(policy([]), { q: noul(1.2) }), /from 0 to 1/);
		assert.throws(() => evaluateRules(policy([]), { q: noul(1.2) }), /Received a number/);
		assert.throws(
			() => evaluateRules(policy([]), { q: { type: 'score', score: 1, confidence: 2 } }),
			/Answer "q" confidence[\s\S]*from 0 to 1/,
		);
		const wide = evaluateRules(policy([hold('high', { all: [{ question: 'risk', gte: 2 }] })]), {
			risk: { type: 'score', score: 99, confidence: 0.5 },
		});
		assert.equal(wide.matched_rule, 'high');
		assert.equal(
			bestEffortConfidence({ type: 'choice', choice: 'a', probabilities: { b: 0.9 } }),
			undefined,
		);
	});
});

describe('trace, receipt, and the flat table', () => {
	it('lists later matches that did not apply, and not when there is no winner', () => {
		const rules = policy([hold('first', { all: [{ fact: 'a', eq: true }] }), hold('second', { all: [{ fact: 'b', eq: true }] })]);
		const trace = traceRules(rules, {}, undefined, { a: true, b: true });
		assert.equal(trace.decision?.matched_rule, 'first');
		assert.deepEqual(trace.also_matched, ['second']);
		assert.equal(trace.rules[1]?.did_not_apply, true);
		const broken = traceRules(
			policy([hold('bad', { all: [{ fact: 'missing', eq: 1 }] }), hold('later', { all: [{ fact: 'b', eq: true }] })]),
			{},
			undefined,
			{ b: true },
		);
		assert.equal(broken.decision, undefined);
		assert.deepEqual(broken.also_matched, []);
		assert.notEqual(broken.rules[1]?.did_not_apply, true);
	});

	it('records paths and question ids up to the winner and not the values', () => {
		const rules = policy([hold('seen', { all: [{ fact: 'touches_ci', eq: 'SECRET-VALUE' }, { question: 'q', gte: 0.5 }] })]);
		const ruleset = validateRuleset(rules);
		const decision = evaluateRules(rules, { q: noul(0.9) }, undefined, { touches_ci: 'SECRET-VALUE' });
		const receipt = decisionReceipt(ruleset, decision);
		assert.equal(receipt.ruleset_hash, rulesetHash(ruleset));
		assert.equal(receipt.matched_rule, 'seen');
		assert.deepEqual(receipt.fact_paths, ['touches_ci']);
		assert.deepEqual(receipt.question_ids, ['q']);
		assert.equal(JSON.stringify(receipt).includes('SECRET-VALUE'), false);
		assert.equal(receipt.error, undefined);
	});

	it('sends opening questions to the server when a script cannot open the gate', () => {
		assert.deepEqual(questionsScriptsCannotOpen(validateRuleset(CI_CHANGE_RULES)), [
			'suspicious_code',
			'description_matches_diff',
			'risk',
		]);
		assert.deepEqual(questionsScriptsCannotOpen(validateRuleset(GENERIC_TRIAGE_RULES)), []);
	});

	it('projects flat conjunctions and leaves a top-level any as a tree', () => {
		const ruleset = validateRuleset(
			policy([
				hold('flat', { all: [{ fact: 'a', eq: 1 }, { fact: 'b', eq: 2 }] }),
				hold('tree', { any: [{ fact: 'a', eq: 1 }] }, false),
			]),
		);
		const table = projectTable(ruleset);
		assert.equal(table.rows[0]?.flat, true);
		assert.equal(table.rows[0]?.when, 'a eq 1 AND b eq 2');
		assert.equal(table.rows[1]?.flat, false);
		assert.equal(table.rows[1]?.when, '(tree)');
	});

	it('compiles one cell as a predicate and rejects operators outside the closed set', () => {
		const one = compileFlatRows([
			{
				id: 'r',
				combine: 'all',
				conditions: [{ subject: 'touches_ci', source: 'fact', operator: 'eq', value: true }],
				action: { type: 'hold', target: 't', reason: 'r', gate: true },
			},
		]);
		assert.deepEqual((one[0] as { when: unknown }).when, { fact: 'touches_ci', eq: true });
		const several = compileFlatRows([
			{
				id: 'r',
				combine: 'any',
				conditions: [
					{ subject: 'a', source: 'fact', operator: 'eq', value: 1 },
					{ subject: 'b', source: 'question', operator: 'gte', value: 'high' },
				],
				action: { type: 'hold', target: 't', reason: 'r', gate: true },
			},
		]);
		assert.deepEqual((several[0] as { when: unknown }).when, {
			any: [
				{ fact: 'a', eq: 1 },
				{ question: 'b', gte: 'high' },
			],
		});
		assert.throws(
			() =>
				compileFlatRows([
					{
						id: 'r',
						combine: 'all',
						conditions: [{ subject: 'a', source: 'fact', operator: 'confidence_gte', value: 0.5 }],
						action: { type: 'hold', target: 't', reason: 'r', gate: true },
					},
				]),
			(error: unknown) => error instanceof RulesError && /confidence_gte/.test(error.message),
		);
		assert.throws(
			() =>
				compileFlatRows([
					{
						id: 'r',
						combine: 'all',
						conditions: [{ subject: 'q', source: 'question', operator: 'contains', value: 'x' }],
						action: { type: 'hold', target: 't', reason: 'r', gate: true },
					},
				]),
			(error: unknown) => error instanceof RulesError && /contains/.test(error.message),
		);
	});
});
