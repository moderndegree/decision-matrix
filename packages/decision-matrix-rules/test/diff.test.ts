import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CI_CHANGE_RULES, diffRulesets, type PolicyChange } from '../src';

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

const effects = (changes: PolicyChange[]) => changes.map((change) => `${change.effect}:${change.rule ?? '-'}`);

const hold = rule('hold', { all: [{ question: 'q', gte: 'high' }] });
const allow = rule('allow', { all: [{ fact: 'ok', eq: true }, { question: 'q', lt: 0.1 }] }, false);

describe('diffRulesets', () => {
	it('reports nothing for an identical ruleset', () => {
		assert.deepEqual(diffRulesets(CI_CHANGE_RULES, JSON.parse(JSON.stringify(CI_CHANGE_RULES))), []);
	});

	it('judges a threshold change through the rules that use it', () => {
		const before = rules([hold, allow]);
		const higher = diffRulesets(before, { ...before, thresholds: { high: 0.95 } });
		assert.deepEqual(effects(higher), ['neutral:-', 'loosens:hold']);
		assert.match(higher[1]!.message, /"hold" matches fewer events after a threshold change, so it holds less often/);
		assert.deepEqual(effects(diffRulesets(before, { ...before, thresholds: { high: 0.5 } })), ['neutral:-', 'tightens:hold']);
	});

	it('flips direction for a rule that opens the gate', () => {
		const before = rules([allow]);
		const wider = rules([rule('allow', { all: [{ fact: 'ok', eq: true }, { question: 'q', lt: 0.3 }] }, false)]);
		assert.deepEqual(effects(diffRulesets(before, wider)), ['loosens:allow']);
		assert.deepEqual(effects(diffRulesets(wider, before)), ['tightens:allow']);
	});

	it('treats dropping a requirement from all as broader', () => {
		const before = rules([allow]);
		const fewer = rules([rule('allow', { all: [{ question: 'q', lt: 0.1 }] }, false)]);
		assert.deepEqual(effects(diffRulesets(before, fewer)), ['loosens:allow']);
	});

	it('asks for review when neither direction can be proven', () => {
		const before = rules([hold]);
		const other = rules([rule('hold', { all: [{ question: 'r', gte: 0.5 }] })]);
		assert.deepEqual(effects(diffRulesets(before, other)), ['review:hold']);
	});

	it('reports removed and added rules by what they did', () => {
		assert.deepEqual(effects(diffRulesets(rules([hold, allow]), rules([allow]))), ['loosens:hold']);
		assert.deepEqual(effects(diffRulesets(rules([hold, allow]), rules([hold]))), ['tightens:allow']);
		const added = diffRulesets(rules([hold]), rules([hold, rule('open', { all: [{ question: 'q', lt: 0.2 }] }, false)]));
		assert.deepEqual(effects(added), ['loosens:open']);
		assert.match(added[0]!.message, /Model answers alone can satisfy it/);
	});

	it('reports gate flips, the strict flag, and the default action', () => {
		const flipped = rules([{ ...hold, action: { ...hold.action, gate: false } }]);
		assert.ok(effects(diffRulesets(rules([hold]), flipped)).includes('loosens:hold'));
		assert.deepEqual(effects(diffRulesets(rules([], { open_gate_requires_facts: true }), rules([]))), ['loosens:-']);
		const open = rules([], { default_action: { type: 'pass', target: 't', reason: 'r', gate: false } });
		assert.deepEqual(effects(diffRulesets(rules([]), open)), ['loosens:-', 'neutral:-', 'neutral:-', 'neutral:-']);
	});

	it('reports a rule that opens the gate moving ahead of a hold', () => {
		assert.deepEqual(effects(diffRulesets(rules([hold, allow]), rules([allow, hold]))), ['loosens:allow']);
		assert.deepEqual(effects(diffRulesets(rules([allow, hold]), rules([hold, allow]))), ['tightens:hold']);
	});
});
