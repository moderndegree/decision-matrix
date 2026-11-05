import type { KeyEvent } from '@opentui/core';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { useMemo, useState } from 'react';

import { diffPolicies, formatPolicyDiff } from 'decision-matrix-cli';

import type { AppIO } from './io';
import {
	EXPECT_FIELDS,
	acceptDecision,
	addBlankCase,
	addCaseFrom,
	addScopeAnswer,
	addScopeFact,
	addThreshold,
	deleteCase,
	deleteRule,
	deleteThreshold,
	derive,
	filesToSave,
	insertRule,
	isDirty,
	isStrict,
	markSaved,
	moveRule,
	parseTyped,
	questionMap,
	removeScopeValue,
	renameCase,
	renameThreshold,
	replaceRule,
	scopeValues,
	setDefaultAction,
	setExpectation,
	setScopeValue,
	setStrict,
	setThreshold,
	stepCaseValue,
	thresholdStep,
	thresholdUsers,
	toggleDefaultGate,
	toggleGate,
	traceCase,
	type CaseScope,
	type EditResult,
	type ExpectField,
	type JsonObject,
	type Workspace,
} from './model';
import { OverlayBox, overlayKey, picker, type Option, type Overlay } from './overlay';
import { QuestionsEditor } from './questions-editor/view';
import { RuleEditor } from './rule-editor/view';
import {
	COLORS,
	DEFAULTS_HEADER,
	Pane,
	caseHeader,
	caseLines,
	defaultLines,
	detailLines,
	inspectorLines,
	ruleLines,
	thresholdLines,
	type Line,
} from './views';

type Focus = 'rules' | 'thresholds' | 'cases' | 'values';
const FOCUS_ORDER: Focus[] = ['rules', 'thresholds', 'cases', 'values'];

interface Status {
	text: string;
	tone: 'text' | 'hold' | 'open' | 'warn';
}

const HINTS: Record<Focus, string> = {
	rules: 'shift+↑↓ move · g gate · e edit · E JSON · n new · x delete',
	thresholds: '←→ adjust · enter type · n new · r rename · x delete',
	cases: 'n new · a copy · r rename · e expects · u accept · x delete',
	values: '←→ space change · enter type · n add · x remove',
};

/** Stands for "not checked" in the expectation pickers, where undefined removes the field. */
const UNSET = { unset: true };

export function App(props: { initial: Workspace; io: AppIO }) {
	const { io } = props;
	const [workspace, setWorkspace] = useState(props.initial);
	const [focus, setFocus] = useState<Focus>('rules');
	const [selection, setSelection] = useState({ rules: 0, thresholds: 0, cases: 1, values: 0 });
	const [overlay, setOverlay] = useState<Overlay | null>(null);
	const [status, setStatus] = useState<Status | null>(null);
	const [busy, setBusy] = useState(false);
	/** The rule open in the form editor. A rule added for it is removed again on cancel. */
	const [editing, setEditing] = useState<{ target: number | 'default'; added: boolean; before: Workspace } | null>(null);
	const [screen, setScreen] = useState<'main' | 'questions'>('main');
	const { width, height } = useTerminalDimensions();

	const derived = useMemo(() => derive(workspace), [workspace]);
	const dirty = isDirty(workspace);
	const strict = isStrict(workspace);
	const rules = derived.ruleset.rules;
	const thresholdNames = Object.keys(derived.ruleset.thresholds);
	const results = derived.run?.results;
	const caseCount = derived.cases.length;

	// The rule list ends with the default action, so it has one more row than there are rules.
	const ruleRow = clamp(selection.rules, rules.length + 1);
	const onDefault = ruleRow === rules.length;
	const thresholdIndex = clamp(selection.thresholds, thresholdNames.length);
	// The cases list starts with the shared defaults, so case i is row i + 1.
	const caseRow = clamp(selection.cases, caseCount + 1);
	const scope: CaseScope = caseRow === 0 ? { kind: 'defaults' } : { kind: 'case', index: caseRow - 1 };
	const caseIndex = scope.kind === 'case' ? scope.index : -1;
	const selectedCase = scope.kind === 'case' ? derived.cases[scope.index] : undefined;
	const selectedResult = scope.kind === 'case' ? results?.[scope.index] : undefined;
	const values = workspace.cases ? scopeValues(workspace, derived, scope) : [];
	const valueIndex = clamp(selection.values, values.length);
	const trace = useMemo(() => (selectedCase ? traceCase(workspace, selectedCase) : undefined), [workspace, selectedCase]);
	const ruleTrace = onDefault ? undefined : trace?.rules[ruleRow];

	const covered = useMemo(() => {
		const counts = new Map<string | null, number>();
		for (const result of results ?? []) {
			if (result.decision) counts.set(result.decision.matched_rule, (counts.get(result.decision.matched_rule) ?? 0) + 1);
		}
		return counts;
	}, [results]);

	function apply(result: EditResult, done?: string): boolean {
		if (!result.ok) {
			setStatus({ text: result.error, tone: 'hold' });
			return false;
		}
		setWorkspace(result.workspace);
		if (done) setStatus({ text: done, tone: 'open' });
		return true;
	}

	function select(pane: Focus, index: number, count: number) {
		setSelection((current) => ({ ...current, [pane]: clamp(index, count) }));
	}

	/** Mouse events reach the panes underneath an overlay. Ignore them until it closes. */
	function pointer(): boolean {
		return !busy && !overlay;
	}

	function pick(pane: Focus, index: number | undefined, count: number) {
		if (!pointer()) return;
		setStatus(null);
		setFocus(pane);
		if (index !== undefined) select(pane, index, count);
	}

	function wheel(pane: Focus, direction: -1 | 1, count: number) {
		if (!pointer()) return;
		setStatus(null);
		setFocus(pane);
		setSelection((current) => ({ ...current, [pane]: clamp(current[pane] + direction, count) }));
	}

	function prompt(title: string, initial: string, submit: (text: string) => void) {
		setOverlay({ kind: 'prompt', title, initial, submit });
	}

	async function editRuleJson() {
		const raw = onDefault ? workspace.rules.default_action : (workspace.rules.rules as unknown[])[ruleRow];
		if (raw === undefined) return;
		setBusy(true);
		try {
			const outcome = await io.editJson(raw, onDefault ? 'default_action' : rules[ruleRow]!.id);
			if (outcome.kind === 'edited') {
				apply(onDefault ? setDefaultAction(workspace, outcome.value) : replaceRule(workspace, ruleRow, outcome.value), onDefault ? 'Default action updated.' : 'Rule updated.');
			} else if (outcome.kind === 'unchanged') setStatus({ text: 'No changes.', tone: 'text' });
			else setStatus({ text: outcome.error, tone: 'hold' });
		} finally {
			setBusy(false);
		}
	}

	function save() {
		if (!dirty.any) {
			setStatus({ text: 'Nothing to save.', tone: 'text' });
			return;
		}
		const diff = diffPolicies(workspace.savedRules, workspace.rules, derived.cases);
		const lines: Line[] = dirty.rules
			? formatPolicyDiff(diff, 'saved', 'edited', false)
					.trimEnd()
					.split('\n')
					.slice(2)
					.map((text) => ({ text, ...(/^Loosens|^Needs review|now opens the gate/.test(text) ? { tone: 'hold' as const } : {}) }))
			: [{ text: 'The rules did not change.' }];
		if (dirty.cases) lines.push({ text: `The cases changed: ${workspace.casesPath}` });
		if (dirty.questions) lines.push({ text: `The questions changed: ${workspace.questionsPath}` });
		setOverlay({
			kind: 'confirm',
			title: dirty.rules && diff.loosens ? 'This change LOOSENS the policy. Save? y/n' : 'Save? y/n',
			lines,
			yes: () => {
				const files = filesToSave(workspace);
				try {
					io.save(files);
					setWorkspace(markSaved(workspace));
					setStatus({ text: `Saved ${files.map((file) => file.path).join(', ')}.`, tone: 'open' });
				} catch (error) {
					setStatus({ text: `Save failed: ${(error as Error).message}`, tone: 'hold' });
				}
			},
		});
	}

	function quit() {
		if (dirty.any) {
			setOverlay({ kind: 'confirm', title: 'Quit without saving? y/n', lines: [{ text: 'Unsaved changes will be lost.' }], yes: () => io.quit() });
		} else {
			io.quit();
		}
	}

	function toggleStrict() {
		if (!strict) {
			apply(setStrict(workspace, true), 'Strict: every rule that opens the gate now needs a fact, and the default must hold.');
			return;
		}
		setOverlay({
			kind: 'confirm',
			title: 'Turn off open_gate_requires_facts? y/n',
			lines: [
				{ text: 'Model answers alone could then open the gate in any rule, and the default could proceed.', tone: 'hold' },
				{ text: 'A model reads text an attacker may have written.' },
			],
			yes: () => apply(setStrict(workspace, false), 'Strict is off. The diff shows this as a loosening.'),
		});
	}

	/** The expectation fields of one case, each opening a picker or a prompt, until escape. */
	function editExpectations(current: Workspace, index: number) {
		const expect = ((current.cases!.cases as JsonObject[])[index]!.expect ?? {}) as JsonObject;
		const show = (field: ExpectField) => (field in expect ? JSON.stringify(expect[field]) : '— not checked');
		const options: Option[] = EXPECT_FIELDS.map((field) => ({ label: `${field.padEnd(13)} ${show(field)}`, value: field }));
		setOverlay(
			picker('What this case expects · enter change · esc done', options, (value) => {
				const field = value as ExpectField;
				const done = (next: unknown) => {
					const result = setExpectation(current, index, field, next === UNSET ? undefined : next);
					if (apply(result) && result.ok) editExpectations(result.workspace, index);
					else editExpectations(current, index);
				};
				if (field === 'matched_rule') {
					const choices: Option[] = [
						...rules.map((rule) => ({ label: rule.id, value: rule.id })),
						{ label: 'the default action (null)', value: null },
						{ label: 'not checked', value: UNSET },
					];
					setOverlay(picker('Which rule must decide', choices, done, expect.matched_rule));
				} else if (field === 'gate' || field === 'from_facts') {
					const choices: Option[] = [
						{ label: 'true', value: true },
						{ label: 'false', value: false },
						{ label: 'not checked', value: UNSET },
					];
					setOverlay(picker(field === 'gate' ? 'The gate must be' : 'Facts alone must decide', choices, done, expect[field]));
				} else {
					prompt(`${field} (empty for not checked)${field === 'error' ? ', a part of the error text' : ''}`, typeof expect[field] === 'string' ? (expect[field] as string) : '', (text) =>
						done(text === '' ? UNSET : text),
					);
				}
			}),
		);
	}

	function addValue() {
		const present = new Set(values.filter((value) => value.kind === 'answer').map((value) => value.path));
		const questions = Object.keys(questionMap(workspace) ?? {}).filter((id) => !present.has(id));
		const options: Option[] = [
			{ label: 'A fact…', value: 'fact' },
			...questions.map((id) => ({ label: `An answer to ${id}`, value: id })),
			{ label: 'An answer to another question id…', value: null, typed: { title: 'Question id', initial: '', parse: (text) => (text.trim() === '' ? undefined : text.trim()) } },
		];
		setOverlay(
			picker(scope.kind === 'defaults' ? 'Add to the defaults' : `Add to "${selectedCase?.name}"`, options, (value) => {
				if (value !== 'fact') return void apply(addScopeAnswer(workspace, scope, value as string), `Added an answer to ${String(value)}.`);
				prompt('Fact path, for example grant.privileged', '', (path) =>
					prompt(`${path} =  (true, false, a number, null, a JSON list, or text)`, '', (text) =>
						apply(addScopeFact(workspace, scope, path, parseTyped(text)), `Added ${path}.`),
					),
				);
			}),
		);
	}

	function onRulesKey(key: KeyEvent, vertical: number) {
		if (vertical && key.shift) {
			if (onDefault) return setStatus({ text: 'The default action is a footer and cannot be moved.', tone: 'text' });
			if (apply(moveRule(workspace, ruleRow, vertical as -1 | 1))) select('rules', ruleRow + vertical, rules.length + 1);
			return;
		}
		if (vertical) return select('rules', ruleRow + vertical, rules.length + 1);
		if (key.name === 'g') {
			if (onDefault) apply(toggleDefaultGate(workspace));
			else if (rules.length > 0) apply(toggleGate(workspace, ruleRow));
		} else if (key.name === 'e' && key.shift) void editRuleJson();
		else if (key.name === 'e') setEditing({ target: onDefault ? 'default' : ruleRow, added: false, before: workspace });
		else if (key.name === 'n') {
			const after = onDefault ? rules.length - 1 : ruleRow;
			const inserted = insertRule(workspace, after);
			if (!inserted.ok) return void apply(inserted);
			setEditing({ target: after + 1, added: true, before: workspace });
			setWorkspace(inserted.workspace);
			select('rules', after + 1, rules.length + 2);
		} else if (key.name === 'x') {
			if (onDefault) return setStatus({ text: 'A ruleset always has a default action. Press e to change it.', tone: 'text' });
			const id = rules[ruleRow]?.id;
			if (id) setOverlay({ kind: 'confirm', title: `Delete "${id}"? y/n`, lines: [], yes: () => apply(deleteRule(workspace, ruleRow), `Deleted "${id}".`) });
		}
	}

	function onThresholdsKey(key: KeyEvent, vertical: number) {
		const name = thresholdNames[thresholdIndex];
		if (vertical) return select('thresholds', thresholdIndex + vertical, thresholdNames.length);
		if (key.name === 'n') {
			return prompt('New threshold name', '', (newName) =>
				prompt(`${newName} =  (a number, for example 0.85)`, '', (text) => {
					if (apply(addThreshold(workspace, newName.trim(), Number(text)), `Added ${newName.trim()}.`)) select('thresholds', thresholdNames.length, thresholdNames.length + 1);
				}),
			);
		}
		if (!name) return;
		if (key.name === 'left' || key.name === 'right') {
			const value = derived.ruleset.thresholds[name]!;
			apply(setThreshold(workspace, name, value + (key.name === 'right' ? 1 : -1) * thresholdStep(value)));
		} else if (key.name === 'return') {
			prompt(`${name} =`, String(derived.ruleset.thresholds[name]), (text) => apply(setThreshold(workspace, name, Number(text)), `${name} set.`));
		} else if (key.name === 'r') {
			prompt(`Rename ${name} to`, name, (text) => apply(renameThreshold(workspace, name, text.trim()), `Renamed to ${text.trim()} in every rule and case.`));
		} else if (key.name === 'x') {
			const users = thresholdUsers(workspace, name);
			if (users.length > 0) return setStatus({ text: `${name} is used by ${users.join(', ')}. Change those first.`, tone: 'hold' });
			setOverlay({ kind: 'confirm', title: `Delete threshold ${name}? y/n`, lines: [{ text: 'No rule uses it.' }], yes: () => apply(deleteThreshold(workspace, name), `Deleted ${name}.`) });
		}
	}

	function onCasesKey(key: KeyEvent, vertical: number) {
		if (!workspace.cases) return setStatus({ text: 'No cases file is open. Start with --cases <file>. A new path creates the file.', tone: 'text' });
		if (vertical) return select('cases', caseRow + vertical, caseCount + 1);
		if (key.name === 'n' || (key.name === 'a' && scope.kind === 'defaults')) {
			const at = scope.kind === 'case' ? scope.index + 1 : caseCount;
			return prompt('Name for the new case', '', (text) => {
				if (apply(addBlankCase(workspace, at, text), 'Case added. It expects what the rules decide now.')) select('cases', at + 1, caseCount + 2);
			});
		}
		if (scope.kind === 'defaults') {
			if (key.name === 'e' || key.name === 'u' || key.name === 'r' || key.name === 'x') {
				setStatus({ text: 'The defaults have no name or expectation. Edit their values in the next pane.', tone: 'text' });
			}
			return;
		}
		const name = selectedCase?.name ?? '';
		if (key.name === 'u') apply(acceptDecision(workspace, caseIndex, derived), 'The case now expects this decision.');
		else if (key.name === 'e') editExpectations(workspace, caseIndex);
		else if (key.name === 'r') prompt(`Rename "${name}" to`, name, (text) => apply(renameCase(workspace, caseIndex, text), 'Renamed.'));
		else if (key.name === 'a') {
			prompt('Name for the copy', `${name} (copy)`, (text) => {
				if (apply(addCaseFrom(workspace, caseIndex, text, derived), 'Case added.')) select('cases', caseRow + 1, caseCount + 2);
			});
		} else if (key.name === 'x') {
			setOverlay({ kind: 'confirm', title: `Delete case "${name}"? y/n`, lines: [], yes: () => apply(deleteCase(workspace, caseIndex), 'Case deleted.') });
		}
	}

	function onValuesKey(key: KeyEvent, vertical: number) {
		if (!workspace.cases) return setStatus({ text: 'No cases file is open. Start with --cases <file>.', tone: 'text' });
		const value = values[valueIndex];
		if (vertical) return select('values', valueIndex + vertical, values.length);
		if (key.name === 'n') return addValue();
		if (!value) return;
		if (key.name === 'left' || key.name === 'right' || key.name === 'space') {
			const next = stepCaseValue(value, key.name === 'left' ? -1 : 1, workspace);
			if (next === undefined) setStatus({ text: 'Press enter to type a value.', tone: 'text' });
			else apply(setScopeValue(workspace, derived, scope, value, next));
		} else if (key.name === 'return') {
			prompt(`${value.path} =`, JSON.stringify(value.value), (text) => apply(setScopeValue(workspace, derived, scope, value, parseTyped(text))));
		} else if (key.name === 'x') {
			apply(removeScopeValue(workspace, scope, value), scope.kind === 'case' ? `Removed. ${value.path} comes from the defaults again, if they set it.` : `Removed ${value.path} from the defaults.`);
		}
	}

	function onKey(key: KeyEvent) {
		if (busy || editing || screen !== 'main') return;
		if (overlay) return overlayKey(key, overlay, setOverlay, (text) => setStatus({ text, tone: 'hold' }));
		setStatus(null);
		if (key.ctrl && key.name === 's') return save();
		if (key.ctrl && key.name === 'c') return io.quit();
		if (key.name === 'q' && key.shift) {
			if (workspace.questions) return setScreen('questions');
			return setStatus({ text: 'No questions file is open. Start with --questions <file>. A new path creates the file.', tone: 'text' });
		}
		if (key.name === 's' && key.shift) return toggleStrict();
		if (key.name === 'q') return quit();
		if (key.sequence === '?') return setOverlay({ kind: 'help', title: 'Keys · any key closes', lines: HELP });
		if (key.name === 'tab') {
			const at = FOCUS_ORDER.indexOf(focus);
			setFocus(FOCUS_ORDER[(at + (key.shift ? FOCUS_ORDER.length - 1 : 1)) % FOCUS_ORDER.length]!);
			return;
		}
		const vertical = key.name === 'up' ? -1 : key.name === 'down' ? 1 : 0;
		if (focus === 'rules') onRulesKey(key, vertical);
		else if (focus === 'thresholds') onThresholdsKey(key, vertical);
		else if (focus === 'cases') onCasesKey(key, vertical);
		else onValuesKey(key, vertical);
	}

	useKeyboard(onKey);

	if (editing) {
		return (
			<RuleEditor
				workspace={workspace}
				derived={derived}
				ruleIndex={editing.target}
				width={width}
				height={height}
				onApply={(draft) => {
					const result = editing.target === 'default' ? setDefaultAction(workspace, draft.action) : replaceRule(workspace, editing.target, draft);
					if (!result.ok) return result.error;
					setWorkspace(result.workspace);
					setEditing(null);
					setStatus({ text: `${editing.target === 'default' ? 'Default action' : 'Rule'} applied. ctrl+s saves the file.`, tone: 'open' });
					return undefined;
				}}
				onCancel={() => {
					if (editing.added) setWorkspace(editing.before);
					setEditing(null);
					setStatus({ text: editing.added ? 'New rule discarded.' : 'No changes applied.', tone: 'text' });
				}}
			/>
		);
	}

	if (screen === 'questions') {
		return (
			<QuestionsEditor
				workspace={workspace}
				derived={derived}
				width={width}
				height={height}
				apply={apply}
				onClose={() => setScreen('main')}
				onSave={() => {
					setScreen('main');
					save();
				}}
			/>
		);
	}

	const topHeight = Math.max(8, Math.floor((height - 2) * 0.55));
	const bottomHeight = Math.max(6, height - 2 - topHeight);
	const passed = results?.filter((result) => result.passed).length ?? 0;
	const errors = derived.findings.filter((finding) => finding.severity === 'error').length;
	const warnings = derived.findings.filter((finding) => finding.severity === 'warning').length;
	const loosens = derived.changes.filter((change) => change.effect === 'loosens' || change.effect === 'review').length;
	const tightens = derived.changes.filter((change) => change.effect === 'tightens').length;
	const header = scope.kind === 'defaults' ? DEFAULTS_HEADER : caseHeader(selectedResult, (workspace.cases?.cases as JsonObject[] | undefined)?.[caseIndex]?.expect as JsonObject | undefined);

	const summary = [
		dirty.any ? `unsaved${dirty.rules && derived.changes.length > 0 ? ` (loosens ${loosens}, tightens ${tightens})` : ''}` : 'saved',
		`lint ${errors} errors ${warnings} warnings`,
		results ? `cases ${passed}/${results.length}` : 'no cases',
	].join(' · ');

	return (
		<box style={{ flexDirection: 'column', width, height, backgroundColor: '#1a1b26' }}>
			<box style={{ flexDirection: 'row', height: topHeight }}>
				<Pane
					title={` Rules · ${workspace.rulesPath}${strict ? ' · strict' : ''} `}
					focused={focus === 'rules'}
					width="45%"
					height={topHeight}
					lines={ruleLines(rules, derived.ruleset.default_action, derived.findings, covered, ruleRow, Boolean(workspace.cases))}
					selectedIndex={ruleRow}
					onPick={(index) => pick('rules', index, rules.length + 1)}
					onWheel={(direction) => wheel('rules', direction, rules.length + 1)}
					onOpen={(index) => {
						if (!pointer() || index < 0 || index > rules.length) return;
						setFocus('rules');
						select('rules', index, rules.length + 1);
						setEditing({ target: index === rules.length ? 'default' : index, added: false, before: workspace });
					}}
				/>
				<Pane
					title={` ${onDefault ? 'default action' : (rules[ruleRow]?.id ?? 'Rule')} `}
					focused={false}
					width="55%"
					height={topHeight}
					lines={
						onDefault
							? defaultLines(derived.ruleset.default_action, derived.findings, strict)
							: detailLines(rules[ruleRow], derived.ruleset.thresholds, ruleTrace?.when, ruleTrace?.error, derived.findings, selectedCase?.name)
					}
					onPick={() => pick('rules', undefined, rules.length + 1)}
				/>
			</box>
			<box style={{ flexDirection: 'row', height: bottomHeight }}>
				<Pane
					title=" Thresholds "
					focused={focus === 'thresholds'}
					width="22%"
					height={bottomHeight}
					lines={thresholdLines(derived.ruleset.thresholds, thresholdIndex)}
					selectedIndex={thresholdIndex}
					onPick={(index) => pick('thresholds', index, thresholdNames.length)}
					onWheel={(direction) => wheel('thresholds', direction, thresholdNames.length)}
					onOpen={(index) => {
						const name = thresholdNames[index];
						if (!pointer() || !name) return;
						pick('thresholds', index, thresholdNames.length);
						prompt(`${name} =`, String(derived.ruleset.thresholds[name]), (text) => apply(setThreshold(workspace, name, Number(text)), `${name} set.`));
					}}
				/>
				<Pane
					title={results ? ` Cases ${passed}/${results.length} ` : ' Cases '}
					focused={focus === 'cases'}
					width="36%"
					height={bottomHeight}
					lines={caseLines(results, caseRow, derived.casesError, Boolean(workspace.cases))}
					selectedIndex={caseRow}
					onPick={(index) => pick('cases', index, caseCount + 1)}
					onWheel={(direction) => wheel('cases', direction, caseCount + 1)}
					onOpen={(index) => {
						if (!pointer()) return;
						pick('cases', index, caseCount + 1);
						if (!workspace.cases) return setStatus({ text: 'No cases file is open. Start with --cases <file>. A new path creates the file.', tone: 'text' });
						if (index === 0) return setStatus({ text: 'The defaults have no name or expectation. Edit their values in the next pane.', tone: 'text' });
						if (index > caseCount) return;
						editExpectations(workspace, index - 1);
					}}
				/>
				<Pane
					title={` ${scope.kind === 'defaults' ? 'defaults' : (selectedCase?.name ?? 'Case')} `}
					focused={focus === 'values'}
					width="42%"
					height={bottomHeight}
					lines={inspectorLines(header, values, valueIndex)}
					selectedIndex={valueIndex + header.length}
					onPick={(index) => {
						const valueAt = index === undefined ? undefined : index - header.length;
						pick('values', valueAt !== undefined && valueAt >= 0 && valueAt < values.length ? valueAt : undefined, values.length);
					}}
					onWheel={(direction) => wheel('values', direction, values.length)}
					onOpen={(index) => {
						const value = values[index - header.length];
						if (!pointer() || !value) return;
						pick('values', index - header.length, values.length);
						prompt(`${value.path} =`, JSON.stringify(value.value), (text) => apply(setScopeValue(workspace, derived, scope, value, parseTyped(text))));
					}}
				/>
			</box>
			{status ? (
				// A message gets both lines and wraps, so the words that explain a refusal are never cut.
				<text wrapMode="word" style={{ height: 2 }} fg={COLORS[status.tone]}>
					{` ${status.text}`}
				</text>
			) : (
				<>
					<text wrapMode="none" truncate fg={loosens > 0 ? COLORS.hold : COLORS.text}>
						{` ${summary}`}
					</text>
					<text wrapMode="none" truncate fg={COLORS.dim}>
						{` ${HINTS[focus]} │ click · wheel · tab · Q · S strict · ^s save · ? · q`}
					</text>
				</>
			)}
			{overlay ? <OverlayBox overlay={overlay} width={width} height={height} set={setOverlay} invalid={(text) => setStatus({ text, tone: 'hold' })} /> : null}
		</box>
	);
}

const HELP: Line[] = [
	{ text: 'Panes: Rules, Thresholds, Cases, and the selected case. Tab and shift+tab move between them.', tone: 'accent' },
	{ text: 'Mouse: click a row to select it and focus its pane. The wheel moves through the pane under the pointer.' },
	{ text: 'Click a row twice to do what enter does: edit a rule, type a value, or open expectations.' },
	{ text: 'The rule editor, the questions screen, and every window have [esc to close] in the upper right. It does what escape does.' },
	{ text: 'Every edit re-runs the linter and every case at once. The rule pane checks the selected case.' },
	{ text: '' },
	{ text: 'Rules     ↑↓ select (the last row is the default action)   shift+↑↓ move   g gate   e edit   E edit as JSON   n new   x delete' },
	{ text: 'Thresh.   ↑↓ select   ←→ adjust   enter type a value   n new   r rename everywhere   x delete an unused one' },
	{ text: 'Cases     the first row is the defaults   n new   a copy   r rename   e expectations   u accept the decision   x delete' },
	{ text: 'Values    ←→ or space change   enter type a value   n add a fact or answer   x remove (a case falls back to the default)' },
	{ text: '' },
	{ text: 'Q  the questions screen: ids, types, instructions, labels, and levels. Renames carry into the rules and cases.' },
	{ text: 'S  turns open_gate_requires_facts on or off. Off asks first: model answers alone could then open the gate.' },
	{ text: '' },
	{ text: '●  holds   ○  opens the gate   facts  decides without the model   ⚠  lint warning   N✓  cases it decides' },
	{ text: '*  the case sets this value. Unmarked values come from the defaults.' },
	{ text: '' },
	{ text: 'ctrl+s  save, after showing what the change does to the policy   q  quit   ctrl+c  quit now', tone: 'dim' },
];

function clamp(index: number, count: number): number {
	if (count <= 0) return 0;
	return Math.min(Math.max(0, index), count - 1);
}
