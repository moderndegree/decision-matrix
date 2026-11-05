import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyRuleRows, readFactsInput, readOptions, readQuestions, readRulesInput, readScripts, readThresholdOverrides } from '../nodes/DecisionMatrix/parameters';

const row = (extra: Record<string, unknown>) => ({
	id: 'r',
	combine: 'all',
	type: 'hold',
	target: 't',
	reason: 'why',
	gate: true,
	conditions: { condition: [{ source: 'fact', subject: 'x', operator: 'eq', value: 'true' }] },
	...extra,
});
const cell = (extra: Record<string, unknown>) => ({ conditions: { condition: [{ source: 'fact', subject: 'x', operator: 'eq', value: 'true', ...extra }] } });
const rules = { version: 1, default_action: { type: 'hold', target: 'h', reason: 'r', gate: true }, rules: [] };

describe('readThresholdOverrides rejects', () => {
	const cases: Array<[string, unknown, RegExp]> = [
		['a non-object', 'x', /must be a collection of name and value rows/],
		['rows that are not a list', { threshold: 'x' }, /must be a collection of name and value rows/],
		['a row that is not an object', { threshold: ['x'] }, /Thresholds row 1 must have a name and a value/],
		['a blank name', { threshold: [{ name: ' ', value: 1 }] }, /Thresholds row 1 is missing a name/],
		['a duplicate name', { threshold: [{ name: 'a', value: 1 }, { name: ' a ', value: 2 }] }, /"a" is defined more than once/],
		['a value that is not a number', { threshold: [{ name: 'a', value: '1' }] }, /"a" must be a finite number/],
		['an empty value', { threshold: [{ name: 'a', value: '' }] }, /"a" must be a finite number/],
	];
	for (const [name, value, message] of cases) it(name, () => assert.throws(() => readThresholdOverrides(value), message));

	it('treats an empty parameter as no overrides', () => {
		for (const value of [undefined, null, '', {}]) assert.deepEqual(readThresholdOverrides(value), {});
	});
});

describe('applyRuleRows rejects', () => {
	const cases: Array<[string, unknown, RegExp]> = [
		['a row that is not an object', 'x', /Rule row 1 must be an object/],
		['a blank id', row({ id: ' ' }), /is missing an id/],
		['a nested combine', row({ combine: 'nested' }), /combine must be "all" or "any"/],
		['a blank type', row({ type: ' ' }), /is missing an action type/],
		['no target', row({ target: undefined }), /is missing a target/],
		['no reason', row({ reason: undefined }), /is missing a reason/],
		['a gate that is not a boolean', row({ gate: 'true' }), /gate must be a boolean/],
		['no conditions', row({ conditions: {} }), /needs at least one condition/],
		['empty conditions', row({ conditions: { condition: [] } }), /needs at least one condition/],
		['a condition that is not an object', row({ conditions: { condition: ['x'] } }), /condition 1 must be one comparison/],
		['an unknown source', row(cell({ source: 'env' })), /source must be "fact" or "question"/],
		['a blank subject', row(cell({ subject: ' ' })), /is missing a subject/],
		['no operator', row(cell({ operator: undefined })), /is missing an operator/],
	];
	for (const [name, value, message] of cases) {
		it(name, () => assert.throws(() => applyRuleRows(rules, { rule: [value] }), message));
	}
});

describe('other parameters', () => {
	it('readRulesInput requires a value and names bad JSON', () => {
		assert.throws(() => readRulesInput(''), /Rules are required/);
		assert.throws(() => readRulesInput('{'), /Rules/);
	});

	it('readFactsInput rejects a list', () => {
		assert.throws(() => readFactsInput('[]'), /Facts must be a JSON object keyed by fact name/);
	});

	it('readOptions rejects a non-object and returns defaults for empty values', () => {
		assert.throws(() => readOptions('x'), /Options must be a collection/);
		assert.deepEqual(readOptions(null), readOptions(undefined));
		assert.deepEqual(readOptions(''), readOptions({}));
	});

	it('readQuestions rejects an unknown set', () => {
		assert.throws(() => readQuestions('nope', {}), /nope/);
	});

	it('readScripts picks a built-in script by question set', () => {
		for (const set of ['generic', 'sdlc', 'support', 'custom', '', undefined]) {
			assert.ok(readScripts('scripts', set, {}, {}), String(set));
		}
		assert.throws(() => readScripts('scripts', 'attack-triage', {}, {}), /has no built-in script/);
	});

	it('readScripts refuses the built-in script when Questions replaces the preset', () => {
		const custom = { q: { type: 'noul', instructions: 'i' } };
		assert.throws(() => readScripts('scripts', 'generic', {}, custom), /Scripts are empty, and Questions replaces the preset/);
	});
});
