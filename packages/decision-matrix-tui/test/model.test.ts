import { describe, expect, test } from 'bun:test';

import { editorCommand } from '../src/io';
import {
	acceptDecision,
	addCaseFrom,
	createWorkspace,
	deleteRule,
	derive,
	insertRule,
	isDirty,
	markSaved,
	moveRule,
	parseTyped,
	replaceRule,
	serialize,
	setScopeValue,
	scopeValues,
	setThreshold,
	stepCaseValue,
	thresholdStep,
	toggleGate,
	type EditResult,
	type Workspace,
} from '../src/model';
import { ciWorkspace, readExample } from './helpers';

function ok(result: EditResult): Workspace {
	if (!result.ok) throw new Error(result.error);
	return result.workspace;
}

const ids = (workspace: Workspace) => derive(workspace).ruleset.rules.map((rule) => rule.id);

describe('workspace', () => {
	test('refuses to open an invalid ruleset or cases file', () => {
		expect(() => createWorkspace({ rulesPath: 'r.json', rules: { version: 2 } })).toThrow(/version must be the number 1/);
		expect(() =>
			createWorkspace({ rulesPath: 'r.json', rules: readExample('ci-change.rules.json'), cases: { version: 1, cases: [{}] } }),
		).toThrow(/name must be a non-empty string/);
	});

	test('derives lint, cases, and an empty diff from the shipped policy', () => {
		const derived = derive(ciWorkspace());
		expect(derived.findings.map((finding) => `${finding.code}:${finding.rule}`)).toEqual([
			'overlap:hold-injection',
			'overlap:hold-suspicious-code',
			'overlap:hold-mismatch',
			'overlap:hold-risk',
			'overlap:auto-merge-dependency-patch',
			'overlap:pass-docs',
			'overlap:pass-small-change',
		]);
		expect(derived.run?.results.every((result) => result.passed)).toBe(true);
		expect(derived.changes).toEqual([]);
	});

	test('tracks unsaved changes until saved', () => {
		const edited = ok(setThreshold(ciWorkspace(), 'injection', 0.9));
		expect(isDirty(edited)).toEqual({ rules: true, cases: false, questions: false, any: true });
		expect(isDirty(markSaved(edited))).toEqual({ rules: false, cases: false, questions: false, any: false });
		expect(serialize({ a: 1 })).toBe('{\n  "a": 1\n}\n');
	});
});

describe('rule edits', () => {
	test('moves, toggles, inserts, and deletes rules', () => {
		const start = ciWorkspace();
		expect(ids(ok(moveRule(start, 0, 1))).slice(0, 2)).toEqual(['hold-package-scripts', 'hold-ci-config']);
		expect(moveRule(start, 0, -1).ok).toBe(false);
		// A facts-only rule may open the gate under open_gate_requires_facts.
		expect(derive(ok(toggleGate(start, 0))).ruleset.rules[0]!.action.gate).toBe(false);
		const inserted = ok(insertRule(start, 0));
		expect(ids(inserted)[1]).toBe('new-rule-1');
		expect(derive(inserted).ruleset.rules[1]!.action.gate).toBe(true);
		expect(ids(ok(insertRule(inserted, 0)))[1]).toBe('new-rule-2');
		expect(ids(ok(deleteRule(start, 0)))[0]).toBe('hold-package-scripts');
	});

	test('rejects an edit that would make the ruleset invalid, and keeps the old one', () => {
		const start = ciWorkspace();
		const bad = replaceRule(start, 0, { id: 'x', when: { all: [] }, action: { type: 'hold', target: 't', reason: 'r' } });
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error).toMatch(/non-empty array/);
		// The strict preset refuses a rule the model alone can open.
		const open = toggleGate(start, 3);
		expect(open.ok).toBe(false);
		if (!open.ok) expect(open.error).toMatch(/"hold-injection"\) opens the gate/);
		const modelOnly = replaceRule(start, 3, {
			id: 'hold-injection',
			when: { all: [{ question: 'risk', lt: 1 }] },
			action: { type: 'pass', target: 'x', reason: 'y', gate: false },
		});
		expect(modelOnly.ok).toBe(false);
		if (!modelOnly.ok) expect(modelOnly.error).toMatch(/opens the gate/);
	});

	test('a loosened threshold shows up in the diff', () => {
		const changes = derive(ok(setThreshold(ciWorkspace(), 'injection', 0.9))).changes;
		expect(changes.map((change) => `${change.effect}:${change.rule ?? '-'}`)).toEqual(['neutral:-', 'loosens:hold-injection']);
		expect(setThreshold(ciWorkspace(), 'injection', Number.NaN).ok).toBe(false);
		expect(thresholdStep(0.5)).toBe(0.05);
		expect(thresholdStep(20)).toBe(1);
	});
});

describe('case edits', () => {
	const workspace = ciWorkspace();
	const derived = derive(workspace);
	const injected = derived.cases.findIndex((entry) => entry.name.startsWith('text addressing'));

	test('lists answers first, then facts, and marks what the case sets itself', () => {
		const values = scopeValues(workspace, derived, { kind: 'case', index: injected });
		expect(values[0]).toMatchObject({ kind: 'answer', path: 'content_contains_instructions', value: 0.8, own: true });
		expect(values.find((value) => value.path === 'touches_ci')).toMatchObject({ kind: 'fact', value: false, own: false });
	});

	test('writes an override on the case and leaves the defaults alone', () => {
		const value = scopeValues(workspace, derived, { kind: 'case', index: 0 }).find((entry) => entry.path === 'docs_only')!;
		const edited = ok(setScopeValue(workspace, derived, { kind: 'case', index: 0 }, value, true));
		const raw = (edited.cases!.cases as Array<{ facts: Record<string, unknown> }>)[0]!;
		expect(raw.facts).toEqual({ touches_ci: true, files_changed: 1, docs_only: true });
		expect((edited.cases!.defaults as { facts: Record<string, unknown> }).facts.docs_only).toBe(false);
	});

	test('a lower injection score makes the case fail', () => {
		const value = scopeValues(workspace, derived, { kind: 'case', index: injected })[0]!;
		const edited = ok(setScopeValue(workspace, derived, { kind: 'case', index: injected }, value, 0.1));
		const result = derive(edited).run!.results[injected]!;
		expect(result.passed).toBe(false);
		expect(result.decision?.matched_rule).toBe('pass-small-change');
	});

	test('steps numbers, toggles booleans, and cycles choice labels', () => {
		const noul = { kind: 'answer', path: 'q', value: 0.98, answerType: 'noul', own: true } as const;
		expect(stepCaseValue(noul, 1, workspace)).toBe(1);
		expect(stepCaseValue({ ...noul, value: 0.5 }, -1, workspace)).toBe(0.45);
		expect(stepCaseValue({ kind: 'fact', path: 'b', value: true, own: true }, 1, workspace)).toBe(false);
		expect(stepCaseValue({ kind: 'fact', path: 'n', value: 3, own: true }, -1, workspace)).toBe(2);
		expect(stepCaseValue({ kind: 'fact', path: 's', value: 'x', own: true }, 1, workspace)).toBeUndefined();
		const withChoice = { ...workspace, questions: { kind: { type: 'choice', instructions: 'Which', criteria: { a: '', b: '', c: '' } } } };
		const choice = { kind: 'answer', path: 'kind', value: 'c', answerType: 'choice', own: true } as const;
		expect(stepCaseValue(choice, 1, withChoice)).toBe('a');
		expect(stepCaseValue(choice, -1, withChoice)).toBe('b');
	});

	test('accepts the current decision and copies a case under a new name', () => {
		const value = scopeValues(workspace, derived, { kind: 'case', index: injected })[0]!;
		const changed = ok(setScopeValue(workspace, derived, { kind: 'case', index: injected }, value, 0.1));
		const accepted = ok(acceptDecision(changed, injected, derive(changed)));
		expect(derive(accepted).run!.results[injected]!.passed).toBe(true);

		const copied = ok(addCaseFrom(workspace, injected, 'injected copy', derived));
		const names = derive(copied).cases.map((entry) => entry.name);
		expect(names[injected + 1]).toBe('injected copy');
		expect(derive(copied).run!.results[injected + 1]!.passed).toBe(true);
		expect(addCaseFrom(workspace, injected, names[0]!, derived).ok).toBe(false);
		expect(addCaseFrom(workspace, injected, '  ', derived).ok).toBe(false);
	});

	test('reads typed values as JSON, or as text', () => {
		expect(parseTyped('0.4')).toBe(0.4);
		expect(parseTyped('null')).toBeNull();
		expect(parseTyped('["a"]')).toEqual(['a']);
		expect(parseTyped('plain words')).toBe('plain words');
	});
});

describe('editorCommand', () => {
	test('prefers VISUAL, then EDITOR, then vi, and splits arguments', () => {
		expect(editorCommand({ VISUAL: 'code --wait', EDITOR: 'nano' })).toEqual(['code', '--wait']);
		expect(editorCommand({ EDITOR: 'nano' })).toEqual(['nano']);
		expect(editorCommand({ VISUAL: ' ' })).toEqual(['vi']);
	});
});
