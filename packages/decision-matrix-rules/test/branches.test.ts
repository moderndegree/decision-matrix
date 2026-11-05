import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	assertFactsResolve,
	diffRulesets,
	evaluateRules,
	flatWhen,
	lintRuleset,
	projectTable,
	validateRuleset,
	type LintFinding,
	type PolicyChange,
} from '../src';

const hold = { type: 'hold', target: 'human', reason: 'No matching rule', gate: true };

function policy(rules: unknown[], extra: Record<string, unknown> = {}) {
	return { version: 1, default_action: hold, rules, ...extra };
}

function rule(id: string, when: unknown, gate = true) {
	return { id, when, action: { type: gate ? 'hold' : 'pass', target: 't', reason: `Rule ${id}`, gate } };
}

const effects = (changes: PolicyChange[]) => changes.map((change) => change.effect);
const has = (findings: LintFinding[], code: string, id?: string) => findings.some((finding) => finding.code === code && (id === undefined || finding.rule === id));

describe('diffRulesets', () => {
	it('treats turning open_gate_requires_facts off as a loosening and on as a tightening', () => {
		const on = policy([], { open_gate_requires_facts: true });
		const off = policy([]);
		assert.deepEqual(effects(diffRulesets(on, off)), ['loosens']);
		assert.deepEqual(effects(diffRulesets(off, on)), ['tightens']);
	});

	it('treats a removed hold as a loosening and a removed opener as a tightening', () => {
		const empty = policy([]);
		assert.deepEqual(effects(diffRulesets(policy([rule('h', { fact: 'x', eq: 1 })]), empty)), ['loosens']);
		assert.deepEqual(effects(diffRulesets(policy([rule('o', { fact: 'x', eq: 1 }, false)]), empty)), ['tightens']);
	});

	it('treats an added agreement as a tightening and a removed one as a loosening', () => {
		const agreement = { question: 'q', fact: 'f', relation: 'eq' };
		const without = policy([]);
		const withIt = policy([], { agreements: [agreement] });
		assert.deepEqual(effects(diffRulesets(without, withIt)), ['tightens']);
		assert.deepEqual(effects(diffRulesets(withIt, without)), ['loosens']);
		assert.deepEqual(diffRulesets(withIt, withIt), []);
	});

	it('calls a rewrite with the same meaning neutral', () => {
		const from = policy([rule('r', { fact: 'x', in: ['a'] }, false)]);
		const to = policy([rule('r', { fact: 'x', eq: 'a' }, false)]);
		assert.deepEqual(effects(diffRulesets(from, to)), ['neutral']);
	});

	it('flips the effect of a broader condition by what the rule does', () => {
		const narrow = { fact: 'n', gte: 5 };
		const broad = { fact: 'n', gte: 1 };
		assert.deepEqual(effects(diffRulesets(policy([rule('r', narrow, false)]), policy([rule('r', broad, false)]))), ['loosens']);
		assert.deepEqual(effects(diffRulesets(policy([rule('r', narrow, true)]), policy([rule('r', broad, true)]))), ['tightens']);
		assert.deepEqual(effects(diffRulesets(policy([rule('r', broad, false)]), policy([rule('r', narrow, false)]))), ['tightens']);
	});

	it('reads a reorder by which rule now wins', () => {
		const a = (gate: boolean) => rule('a', { fact: 'x', eq: 1 }, gate);
		const b = (gate: boolean) => rule('b', { fact: 'y', eq: 1 }, gate);
		assert.deepEqual(effects(diffRulesets(policy([b(true), a(false)]), policy([a(false), b(true)]))), ['loosens']);
		assert.deepEqual(effects(diffRulesets(policy([b(false), a(true)]), policy([a(true), b(false)]))), ['tightens']);
		assert.deepEqual(effects(diffRulesets(policy([b(true), a(true)]), policy([a(true), b(true)]))), ['neutral']);
	});
});

describe('lintRuleset', () => {
	it('returns one invalid finding for a ruleset that does not validate', () => {
		const findings = lintRuleset({ version: 2 });
		assert.equal(findings.length, 1);
		assert.equal(findings[0]?.code, 'invalid');
		assert.equal(findings[0]?.severity, 'error');
	});

	it('reports an undefined threshold, and accepts one from an override', () => {
		const rules = policy([rule('r', { question: 'q', gte: { threshold: 'missing' } })]);
		assert.ok(has(lintRuleset(rules), 'unknown-threshold'));
		assert.ok(!has(lintRuleset(rules, { thresholdOverrides: { missing: 0.5 } }), 'unknown-threshold'));
	});

	const overlaps = (left: unknown, right: unknown) =>
		has(lintRuleset(policy([rule('first', left, false), rule('second', right, true)])), 'overlap', 'second');

	it('does not warn about overlap when no input can satisfy both rules', () => {
		const disjoint: Array<[unknown, unknown]> = [
			[{ fact: 'n', gte: 5 }, { fact: 'n', lt: 5 }],
			[{ fact: 'n', gt: 5 }, { fact: 'n', lte: 5 }],
			[{ fact: 'n', gt: 5 }, { fact: 'n', lt: 1 }],
			[{ fact: 's', in: ['a'] }, { fact: 's', in: ['b'] }],
			[{ fact: 's', in: ['a', 'b'] }, { fact: 's', not_in: ['a', 'b'] }],
			[{ fact: 'l', contains: 'a' }, { fact: 'l', not_contains: 'a' }],
		];
		for (const [left, right] of disjoint) assert.ok(!overlaps(left, right), JSON.stringify([left, right]));
	});

	it('warns about overlap when an input can satisfy both rules', () => {
		const shared: Array<[unknown, unknown]> = [
			[{ fact: 'n', gte: 5 }, { fact: 'n', lte: 5 }],
			[{ fact: 's', in: ['a', 'b'] }, { fact: 's', in: ['b', 'c'] }],
			[{ fact: 's', in: ['a', 'b'] }, { fact: 's', not_in: ['a'] }],
			[{ fact: 'l', contains: 'a' }, { fact: 'l', not_contains: 'b' }],
			[{ fact: 'a', eq: 1 }, { fact: 'b', eq: 1 }],
		];
		for (const [left, right] of shared) assert.ok(overlaps(left, right), JSON.stringify([left, right]));
	});

	it('does not claim overlap from exclusions alone, which name no finite domain', () => {
		assert.ok(!overlaps({ fact: 's', not_in: ['a'] }, { fact: 's', not_in: ['b'] }));
	});

	// subjectSatisfiable treats a number mixed with membership as a contradiction, but n = 7 satisfies
	// both rules here and the opener wins. Lint stays silent, so the hold is beaten with no warning.
	it('warns when an opener overlaps a hold through a range and a value', { todo: 'lint.ts subjectSatisfiable returns false for mixed atoms' }, () => {
		assert.ok(overlaps({ fact: 'n', gte: 5 }, { fact: 'n', eq: 7 }));
	});

	it('finds a rule shadowed through not_in and contains', () => {
		const shadowed = (earlier: unknown, later: unknown) =>
			has(lintRuleset(policy([rule('earlier', earlier), rule('later', later)])), 'shadowed', 'later');
		assert.ok(shadowed({ fact: 's', not_in: ['a'] }, { fact: 's', not_in: ['a', 'b'] }));
		assert.ok(!shadowed({ fact: 's', not_in: ['a', 'b'] }, { fact: 's', not_in: ['a'] }));
		assert.ok(shadowed({ fact: 's', not_in: ['z'] }, { fact: 's', in: ['a'] }));
		assert.ok(shadowed({ fact: 'l', contains: 'a' }, { fact: 'l', contains: 'a' }));
		assert.ok(!shadowed({ fact: 'l', contains: 'a' }, { fact: 'l', contains: 'b' }));
		assert.ok(!shadowed({ fact: 'l', contains: 'a' }, { fact: 'l', not_contains: 'a' }));
	});

	it('checks instant facts against their schema type', () => {
		const schema = { fact_schema: { t: { type: 'instant', required: true } } };
		const ok = policy([rule('r', { fact: 't', gte: '2026-01-01T00:00:00Z' })], schema);
		assert.ok(!has(lintRuleset(ok), 'fact-type'));
		const list = policy([rule('r', { fact: 't', in: ['2026-01-01T00:00:00Z'] })], schema);
		assert.ok(!has(lintRuleset(list), 'fact-type'));
		const contains = policy([rule('r', { fact: 't', contains: 'x' })], schema);
		assert.ok(has(lintRuleset(contains), 'fact-type', 'r'));
	});
});

describe('flatWhen and projectTable', () => {
	it('prints thresholds, instants, lists, and quoted values', () => {
		const ruleset = validateRuleset(
			policy(
				[
					rule('threshold', { question: 'q', gte: { threshold: 'high' } }),
					rule('number', { fact: 'n', lt: 3 }),
					rule('instant', { fact: 't', gte: '2026-01-02T03:04:05Z' }),
					rule('list', { fact: 's', in: ['a', 'two words'] }),
				],
				{ thresholds: { high: 0.8 }, fact_schema: { t: { type: 'instant', required: false } } },
			),
		);
		const when = Object.fromEntries(projectTable(ruleset).rows.map((row) => [row.id, row.when]));
		assert.equal(when.threshold, 'q gte high');
		assert.equal(when.number, 'n lt 3');
		assert.equal(when.instant, 't gte 2026-01-02T03:04:05.000Z');
		assert.equal(when.list, 's in a, "two words"');
	});

	it('returns undefined for a nested group', () => {
		const ruleset = validateRuleset(
			policy([rule('r', { all: [{ any: [{ fact: 'a', eq: 1 }, { fact: 'b', eq: 1 }] }, { fact: 'c', eq: 1 }] })]),
		);
		assert.equal(flatWhen(ruleset.rules[0]!.when), undefined);
	});
});

describe('agreements on each answer shape', () => {
	const opening = (fact: string, relation: string) =>
		policy([rule('open', { fact: 'ok', eq: true }, false)], { agreements: [{ question: 'q', fact, relation }] });

	it('compares a choice with a string fact', () => {
		const answer = { q: { type: 'choice', choice: 'prod' } } as const;
		assert.equal(evaluateRules(opening('env', 'eq'), answer, undefined, { ok: true, env: 'prod' }).gate, false);
		assert.equal(evaluateRules(opening('env', 'eq'), answer, undefined, { ok: true, env: 'dev' }).gate, true);
		assert.equal(evaluateRules(opening('env', 'inverse'), answer, undefined, { ok: true, env: 'prod' }).gate, true);
	});

	it('compares a score with a number fact', () => {
		const answer = { q: { type: 'score', score: 2 } } as const;
		assert.equal(evaluateRules(opening('level', 'eq'), answer, undefined, { ok: true, level: 2 }).gate, false);
		assert.equal(evaluateRules(opening('level', 'eq'), answer, undefined, { ok: true, level: 3 }).gate, true);
	});
});

describe('fact_schema types', () => {
	const typed = (type: string) => policy([], { fact_schema: { f: { type, required: true } } });

	it('refuses a list that holds an object', () => {
		assert.throws(() => assertFactsResolve(typed('array'), { f: [{ nested: true }] as never }), /Fact "f" is a list, so it may hold only/);
	});

	const accepted: Array<[string, unknown]> = [
		['string', 'a'],
		['number', 1.5],
		['boolean', false],
		['null', null],
		['instant', '2026-01-01T00:00:00Z'],
		['array', ['a', 1]],
	];
	const refused: Array<[string, unknown]> = [
		['string', 1],
		['number', '1'],
		['boolean', 'true'],
		['null', 0],
		['instant', 'yesterday'],
		['array', 'a'],
	];

	for (const [type, value] of accepted) {
		it(`accepts ${JSON.stringify(value)} as ${type}`, () => {
			assert.doesNotThrow(() => assertFactsResolve(typed(type), { f: value as never }));
		});
	}
	for (const [type, value] of refused) {
		it(`refuses ${JSON.stringify(value)} as ${type}`, () => {
			assert.throws(() => assertFactsResolve(typed(type), { f: value as never }), new RegExp(`Fact "f" is declared ${type}`));
		});
	}
});
