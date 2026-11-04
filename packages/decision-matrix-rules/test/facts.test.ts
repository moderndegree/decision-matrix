import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	assertFactsResolve,
	decideFromFacts,
	evaluateRules,
	referencedFacts,
	referencedQuestions,
	validateRuleset,
	type AnswerView,
} from '../src';

function noul(value: number): AnswerView {
	return { type: 'noul', noul: value };
}

function score(value: number, confidence = 0.9): AnswerView {
	return { type: 'score', score: value, confidence };
}

function ruleset(rules: unknown[], extra: Record<string, unknown> = {}) {
	return {
		version: 1,
		default_action: { type: 'hold', target: 'human', reason: 'No matching rule', gate: true },
		thresholds: { limit: 10 },
		rules,
		...extra,
	};
}

function rule(id: string, when: unknown, gate = true) {
	return { id, when, action: { type: gate ? 'hold' : 'pass', target: 't', reason: `Rule ${id}`, gate } };
}

describe('fact predicates', () => {
	it('compares scalars strictly with eq, neq, in, and not_in', () => {
		const rules = ruleset([
			rule('admin', { all: [{ fact: 'user.role', eq: 'admin' }, { fact: 'user.mfa', neq: true }] }),
			rule('listed', { all: [{ fact: 'user.role', in: ['viewer', 'editor'] }, { fact: 'region', not_in: ['eu'] }] }),
		]);
		const facts = (role: string, mfa: boolean, region = 'us') => ({ user: { role, mfa }, region });
		assert.equal(evaluateRules(rules, {}, undefined, facts('admin', false)).matched_rule, 'admin');
		assert.equal(evaluateRules(rules, {}, undefined, facts('admin', true)).matched_rule, null);
		assert.equal(evaluateRules(rules, {}, undefined, facts('editor', true)).matched_rule, 'listed');
		assert.equal(evaluateRules(rules, {}, undefined, facts('editor', true, 'eu')).matched_rule, null);
	});

	it('compares numbers with thresholds and literals, and reads arrays with contains', () => {
		const rules = ruleset([
			rule('many', { all: [{ fact: 'count', gt: 'limit' }] }),
			rule('tagged', { all: [{ fact: 'tags', contains: 'prod' }, { fact: 'tags', not_contains: 'sandbox' }] }),
			rule('zero', { all: [{ fact: 'count', lte: 0 }] }),
		]);
		assert.equal(evaluateRules(rules, {}, undefined, { count: 11, tags: [] }).matched_rule, 'many');
		assert.equal(evaluateRules(rules, {}, { limit: 20 }, { count: 11, tags: [] }).matched_rule, null);
		assert.equal(evaluateRules(rules, {}, undefined, { count: 5, tags: ['prod'] }).matched_rule, 'tagged');
		assert.equal(evaluateRules(rules, {}, undefined, { count: 5, tags: ['prod', 'sandbox'] }).matched_rule, null);
		assert.equal(evaluateRules(rules, {}, undefined, { count: 0, tags: [] }).matched_rule, 'zero');
	});

	it('treats a missing fact or a wrong type as an error, never as false', () => {
		const deny = ruleset([rule('deny', { all: [{ fact: 'tainted', eq: true }] })]);
		assert.throws(() => evaluateRules(deny, {}, undefined, {}), /fact "tainted", which is missing/);
		assert.throws(() => evaluateRules(deny, {}), /fact "tainted", which is missing/);
		assert.throws(() => evaluateRules(deny, {}, undefined, { tainted: 'true' }), /compares a string fact with true/);
		assert.throws(() => evaluateRules(deny, {}, undefined, { tainted: { yes: true } }), /needs a string, number, boolean, or null/);
		const numeric = ruleset([rule('n', { all: [{ fact: 'count', gte: 1 }] })]);
		assert.throws(() => evaluateRules(numeric, {}, undefined, { count: null }), /needs a finite number/);
		assert.throws(() => evaluateRules(numeric, {}, undefined, { count: '3' }), /needs a finite number/);
		const nested = ruleset([rule('n', { all: [{ fact: 'a.b', eq: 1 }] })]);
		assert.throws(() => evaluateRules(nested, {}, undefined, { a: 1 }), /fact "a.b", which is missing/);
		// null is a value. It equals null and does not equal true.
		assert.equal(evaluateRules(deny, {}, undefined, { tainted: null }).matched_rule, null);
	});

	it('reads only own properties', () => {
		const rules = ruleset([rule('r', { all: [{ fact: 'toString', eq: 'x' }] })]);
		assert.throws(() => evaluateRules(rules, {}, undefined, {}), /missing/);
		assert.throws(() => validateRuleset(ruleset([rule('r', { all: [{ fact: 'a.__proto__', eq: 1 }] })])), /not a fact path/);
	});

	it('rejects confidence operators, unknown keys, and empty predicates on facts', () => {
		assert.throws(
			() => validateRuleset(ruleset([rule('r', { all: [{ fact: 'a', confidence_gte: 0.5 }] })])),
			/has no confidence/,
		);
		assert.throws(() => validateRuleset(ruleset([rule('r', { all: [{ fact: 'a', matches: 'x' }] })])), /unknown key "matches"/);
		assert.throws(() => validateRuleset(ruleset([rule('r', { all: [{ fact: 'a' }] })])), /has no operator/);
		assert.throws(() => validateRuleset(ruleset([rule('r', { all: [{ fact: 'a', question: 'b', eq: 1 }] })])), /exactly one of/);
		assert.throws(() => validateRuleset(ruleset([rule('r', { all: [{ fact: 'a', eq: [1] }] })])), /must be a string, a finite number/);
	});

	it('keeps question confidence and gives a facts-only rule confidence 1', () => {
		const rules = ruleset([
			rule('mixed', { all: [{ fact: 'ok', eq: true }, { question: 'risk', lt: 2 }] }),
			rule('facts', { all: [{ fact: 'ok', eq: false }] }),
		]);
		assert.equal(evaluateRules(rules, { risk: score(1, 0.7) }, undefined, { ok: true }).confidence, 0.7);
		assert.equal(evaluateRules(rules, { risk: score(1, 0.7) }, undefined, { ok: false }).confidence, 1);
	});

	it('renders facts in templates', () => {
		const rules = {
			...ruleset([]),
			default_action: { type: 'hold', target: '{{facts.owner.team}}', reason: 'By {{facts.author}} ({{facts.missing}})', gate: true },
		};
		const result = evaluateRules(rules, {}, undefined, { owner: { team: 'payments' }, author: 'octocat' });
		assert.equal(result.target, 'payments');
		assert.equal(result.reason, 'By octocat ()');
	});

	it('lists referenced facts apart from questions', () => {
		const parsed = validateRuleset(
			ruleset([rule('r', { any: [{ fact: 'a.b', eq: 1 }, { question: 'q', gte: 0.5 }, { fact: 'c', eq: 2 }] })]),
		);
		const when = parsed.rules[0]!.when;
		assert.deepEqual(referencedFacts(when), ['a.b', 'c']);
		assert.deepEqual(referencedQuestions(when), ['q']);
	});

	it('checks every referenced fact before the server call', () => {
		const rules = ruleset([rule('r', { all: [{ fact: 'a', eq: 1 }, { question: 'q', gte: 0.5 }] })]);
		assert.throws(() => assertFactsResolve(rules, {}), /fact "a", which is missing/);
		assert.doesNotThrow(() => assertFactsResolve(rules, { a: 'any type is fine here' }));
		assert.throws(() => assertFactsResolve(rules, [] as unknown as Record<string, unknown>), /Facts must be a JSON object/);
	});
});

describe('open_gate_requires_facts', () => {
	const strict = (rules: unknown[], extra: Record<string, unknown> = {}) =>
		ruleset(rules, { open_gate_requires_facts: true, ...extra });

	it('requires the default action to hold', () => {
		assert.throws(
			() => validateRuleset(strict([], { default_action: { type: 'pass', target: 't', reason: 'r', gate: false } })),
			/default_action.gate must be true/,
		);
		assert.throws(() => validateRuleset(ruleset([], { open_gate_requires_facts: 'yes' })), /must be a boolean/);
	});

	it('rejects a rule that model answers alone can open', () => {
		assert.throws(() => validateRuleset(strict([rule('open', { all: [{ question: 'q', gte: 0.9 }] }, false)])), /"open"\) opens the gate/);
		// A fact next to a question-only branch under any does not count.
		assert.throws(
			() =>
				validateRuleset(
					strict([rule('open', { any: [{ fact: 'ok', eq: true }, { question: 'q', gte: 0.9 }] }, false)]),
				),
			/opens the gate/,
		);
	});

	it('accepts a fact on every path, and holds that need no fact', () => {
		const parsed = validateRuleset(
			strict([
				rule('hold', { all: [{ question: 'q', gte: 0.5 }] }),
				rule('open', { all: [{ fact: 'ok', eq: true }, { question: 'q', lt: 0.1 }] }, false),
				rule(
					'open-any',
					{ any: [{ all: [{ fact: 'a', eq: true }, { question: 'q', lt: 0.1 }] }, { fact: 'b', eq: true }] },
					false,
				),
			]),
		);
		assert.equal(parsed.open_gate_requires_facts, true);
		assert.equal(validateRuleset(ruleset([])).open_gate_requires_facts, undefined);
	});
});

describe('decideFromFacts', () => {
	const rules = ruleset([
		rule('facts-hold', { all: [{ fact: 'touches_ci', eq: true }] }),
		rule('model-hold', { all: [{ question: 'q', gte: 0.5 }] }),
		rule('facts-later', { all: [{ fact: 'docs_only', eq: true }] }, false),
	]);

	it('returns the first facts-only match, the same decision evaluateRules makes', () => {
		const facts = { touches_ci: true, docs_only: true };
		const early = decideFromFacts(rules, facts);
		assert.equal(early?.matched_rule, 'facts-hold');
		assert.deepEqual(early, evaluateRules(rules, { q: noul(0.9) }, undefined, facts));
	});

	it('stops at the first rule that needs a model answer', () => {
		// facts-later would match, but model-hold comes first and could match once answers exist.
		assert.equal(decideFromFacts(rules, { touches_ci: false, docs_only: true }), null);
		assert.equal(decideFromFacts(ruleset([rule('a', { all: [{ fact: 'x', eq: 1 }] })]), { x: 2 }), null);
	});
});
