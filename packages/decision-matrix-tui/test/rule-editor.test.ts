import { describe, expect, test } from 'bun:test';

import {
	addCondition,
	addGroup,
	addOperator,
	buildRows,
	cycleOperator,
	cycleType,
	defaultValue,
	deleteNode,
	deleteOperator,
	describeRule,
	moveNode,
	setField,
	setOperatorValue,
	setSubject,
	toggleGate,
	toggleGroup,
	validOperators,
	wrapInGroup,
	type Edit,
	type EditorContext,
	type JsonObject,
} from '../src/rule-editor/model';
import { readExample } from './helpers';

const questions = readExample('ci-change.questions.json') as EditorContext['questions'];
const context: EditorContext = {
	questions: { ...questions, kind: { type: 'choice', criteria: { bugfix: '', feature: '', docs: '' } } },
	thresholds: { high_confidence: 0.85, injection: 0.5, high_risk: 2 },
	facts: ['docs_only', 'files_changed', 'touches_ci'],
	factSamples: { docs_only: false, files_changed: 3, touches_ci: false },
	actionTypes: ['hold', 'block', 'pass'],
};

const rules = (readExample('ci-change.rules.json') as { rules: JsonObject[] }).rules;
const mismatch = rules.find((rule) => rule.id === 'hold-mismatch')!;
const injection = rules.find((rule) => rule.id === 'hold-injection')!;

function ok(edit: Edit): JsonObject {
	if (!edit.ok) throw new Error(edit.error);
	return edit.draft;
}

describe('rows', () => {
	test('lay out the rule, the action, and the condition tree', () => {
		const rows = buildRows(mismatch, context);
		expect(rows.map((row) => row.kind)).toEqual([
			'section', 'field', 'field', 'section', 'field', 'field', 'field', 'gate', 'section',
			'group', 'predicate', 'operator', 'add-operator',
			'group', 'predicate', 'operator', 'add-operator', 'predicate', 'operator', 'add-operator', 'add-condition',
			'add-condition',
		]);
		const nested = rows[14]!;
		expect(nested).toMatchObject({ kind: 'predicate', path: ['when', 'any', 1, 'all', 0], subject: { kind: 'fact', name: 'docs_only' } });
		expect(rows[10]).toMatchObject({ subject: { kind: 'question', name: 'description_matches_diff', type: 'noul' } });
	});

	test('read back as plain sentences', () => {
		expect(describeRule(mismatch, context)).toEqual([
			'Holds: hold → human',
			'when',
			'  any of these is true:',
			'    • description_matches_diff is less than 0.5',
			'    all of these are true:',
			'      • the fact docs_only is true',
			'      • changes_runtime_behavior is at least 0.5',
		]);
		expect(describeRule(injection, context)[2]).toBe('  • content_contains_instructions is at least injection (0.5)');
	});
});

describe('operators', () => {
	test('offer only what fits the subject', () => {
		expect(validOperators({ kind: 'question', name: 'q', type: 'noul' })).toEqual(['gte', 'gt', 'lte', 'lt']);
		expect(validOperators({ kind: 'question', name: 'q', type: 'choice' })).toContain('in');
		expect(validOperators({ kind: 'question', name: 'q', type: 'choice' })).not.toContain('gte');
		expect(validOperators({ kind: 'fact', name: 'f' })).toContain('contains');
	});

	test('keep or convert the value when the operator changes', () => {
		const path = ['when', 'all', 0];
		const gt = ok(cycleOperator(injection, path, 'gte', 1, context));
		expect((gt.when as { all: JsonObject[] }).all[0]).toEqual({ question: 'content_contains_instructions', gt: 'injection' });

		const choice = { id: 'c', when: { all: [{ question: 'kind', eq: 'docs' }] }, action: { type: 'hold', target: 't', reason: 'r', gate: true } };
		const listed = ok(cycleOperator(choice, path, 'eq', 1, context));
		expect((listed.when as { all: JsonObject[] }).all[0]).toEqual({ question: 'kind', neq: 'docs' });
		const asList = ok(cycleOperator(listed, path, 'neq', 1, context));
		expect((asList.when as { all: JsonObject[] }).all[0]).toEqual({ question: 'kind', in: ['docs'] });
		const toConfidence = ok(cycleOperator(choice, path, 'eq', -1, context));
		expect((toConfidence.when as { all: JsonObject[] }).all[0]).toEqual({ question: 'kind', confidence_lt: 'high_confidence' });
	});

	test('skip operators the condition already uses, and refuse to remove the last one', () => {
		const two = ok(addOperator(injection, ['when', 'all', 0], context));
		const node = (two.when as { all: JsonObject[] }).all[0]!;
		expect(Object.keys(node)).toEqual(['question', 'gte', 'gt']);
		expect(ok(cycleOperator(two, ['when', 'all', 0], 'gte', 1, context)).when).toEqual({ all: [{ question: 'content_contains_instructions', lte: 'injection', gt: 0.5 }] });
		expect(deleteOperator(injection, ['when', 'all', 0], 'gte').ok).toBe(false);
		expect(ok(deleteOperator(two, ['when', 'all', 0], 'gte')).when).toEqual({ all: [{ question: 'content_contains_instructions', gt: 0.5 }] });
	});

	test('defaults suit the subject', () => {
		expect(defaultValue('in', { kind: 'question', name: 'kind', type: 'choice' }, context)).toEqual(['bugfix']);
		expect(defaultValue('gte', { kind: 'question', name: 'risk', type: 'score' }, context)).toBe(1);
		expect(defaultValue('confidence_gte', { kind: 'question', name: 'kind', type: 'choice' }, context)).toBe('high_confidence');
		expect(defaultValue('eq', { kind: 'fact', name: 'f' }, context)).toBe(true);
	});

	test('set a value directly', () => {
		const edited = ok(setOperatorValue(injection, ['when', 'all', 0], 'gte', 'high_confidence'));
		expect(describeRule(edited, context)[2]).toBe('  • content_contains_instructions is at least high_confidence (0.85)');
	});
});

describe('subjects', () => {
	test('switching between a question and a fact starts over with a comparison that fits', () => {
		const choice = { id: 'c', when: { all: [{ question: 'kind', in: ['docs'] }] }, action: { type: 'hold', target: 't', reason: 'r', gate: true } };
		const first = (draft: JsonObject) => (draft.when as { all: JsonObject[] }).all[0];
		// The cases say docs_only is true or false, and files_changed is a number.
		expect(first(ok(setSubject(choice, ['when', 'all', 0], { kind: 'fact', name: 'docs_only' }, context)))).toEqual({ fact: 'docs_only', eq: false });
		expect(first(ok(setSubject(injection, ['when', 'all', 0], { kind: 'fact', name: 'files_changed' }, context)))).toEqual({ fact: 'files_changed', gte: 3 });
		expect(first(ok(setSubject(choice, ['when', 'all', 0], { kind: 'question', name: 'suspicious_code' }, context)))).toEqual({ question: 'suspicious_code', gte: 0.5 });
		expect(setSubject(choice, ['when', 'all', 0], { kind: 'fact', name: 'two words' }, context).ok).toBe(false);
	});

	test('moving between questions of the same type keeps the comparison', () => {
		const moved = ok(setSubject(injection, ['when', 'all', 0], { kind: 'question', name: 'suspicious_code' }, context));
		expect((moved.when as { all: JsonObject[] }).all[0]).toEqual({ question: 'suspicious_code', gte: 'injection' });
	});
});

describe('structure', () => {
	test('add, nest, wrap, toggle, move, and delete conditions', () => {
		const path = ['when', 'any', 0];
		const added = ok(addCondition(mismatch, ['when'], context, 1));
		const list = (added.when as { any: JsonObject[] }).any;
		expect(list).toHaveLength(3);
		expect(list[1]).toEqual({ question: 'content_contains_instructions', gte: 0.5 });

		const grouped = ok(addGroup(mismatch, ['when'], context));
		expect((grouped.when as { any: JsonObject[] }).any[2]).toEqual({ any: [{ question: 'content_contains_instructions', gte: 0.5 }] });

		const wrapped = ok(wrapInGroup(mismatch, path));
		expect((wrapped.when as { any: JsonObject[] }).any[0]).toEqual({ all: [{ question: 'description_matches_diff', lt: 0.5 }] });

		expect(Object.keys(ok(toggleGroup(mismatch, ['when'])).when as object)).toEqual(['all']);

		const moved = ok(moveNode(mismatch, path, 1));
		expect((moved.when as { any: JsonObject[] }).any[1]).toEqual({ question: 'description_matches_diff', lt: 0.5 });
		expect(moveNode(mismatch, path, -1).ok).toBe(false);

		expect((ok(deleteNode(mismatch, path)).when as { any: unknown[] }).any).toHaveLength(1);
		expect(deleteNode(mismatch, ['when']).ok).toBe(false);
		expect(deleteNode(injection, ['when', 'all', 0]).ok).toBe(false);
	});
});

describe('fields', () => {
	test('validate the id and required action fields, and cycle the type', () => {
		expect(setField(injection, 'id', 'has space').ok).toBe(false);
		expect(ok(setField(injection, 'id', 'renamed')).id).toBe('renamed');
		expect(setField(injection, 'target', '  ').ok).toBe(false);
		expect('description' in ok(setField(injection, 'description', ''))).toBe(false);
		expect((ok(cycleType(injection, 1, context)).action as JsonObject).type).toBe('pass');
		expect((ok(toggleGate(injection)).action as JsonObject).gate).toBe(false);
	});
});
