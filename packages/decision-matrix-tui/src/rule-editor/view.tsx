import type { KeyEvent } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useMemo, useState } from 'react';

import { assertThresholdsResolve, isPlainObject, lintRuleset, referencedFacts, validateRuleset } from 'decision-matrix-rules';
import { diffPolicies } from 'decision-matrix-cli';

import type { Derived, Workspace } from '../model';
import { parseTyped, questionMap } from '../model';
import { OverlayBox, overlayKey, type Option, type Overlay } from '../overlay';
import { COLORS, visibleWindow, type Line, type Tone } from '../views';
import {
	addCondition,
	addGroup,
	addOperator,
	at,
	buildRows,
	choiceLabels,
	cycleOperator,
	cycleType,
	deleteNode,
	deleteOperator,
	describeRule,
	moveNode,
	operatorWords,
	selectable,
	setField,
	setOperatorValue,
	setSubject,
	toggleGate,
	toggleGroup,
	valueText,
	wrapInGroup,
	type Edit,
	type EditorContext,
	type JsonObject,
	type Path,
	type Row,
	type Subject,
} from './model';

export interface RuleEditorProps {
	workspace: Workspace;
	derived: Derived;
	/** A rule's index, or "default" for the default action. */
	ruleIndex: number | 'default';
	width: number;
	height: number;
	/** Returns an error to show, or undefined when the rule was applied. */
	onApply: (draft: JsonObject) => string | undefined;
	onCancel: () => void;
}

export function RuleEditor(props: RuleEditorProps) {
	const { workspace, derived, ruleIndex } = props;
	const actionOnly = ruleIndex === 'default';
	const original = useMemo(
		() => clone(ruleIndex === 'default' ? { action: workspace.rules.default_action } : (workspace.rules.rules as JsonObject[])[ruleIndex]!),
		[workspace, ruleIndex],
	);
	const [draft, setDraft] = useState<JsonObject>(original);
	const [overlay, setOverlay] = useState<Overlay | null>(null);
	const [message, setMessage] = useState<{ text: string; tone: Tone } | null>(null);

	const context = useMemo(() => editorContext(workspace, derived), [workspace, derived]);
	const rows = buildRows(draft, context, actionOnly);
	const [selected, setSelected] = useState(() => Math.max(0, rows.findIndex((row) => row.kind === 'group' || row.kind === 'predicate' || (actionOnly && row.kind === 'field'))));
	const index = clampSelectable(rows, selected);
	const row = rows[index]!;
	const preview = useMemo(() => previewFor(workspace, derived, ruleIndex, draft), [workspace, derived, ruleIndex, draft]);
	const changed = JSON.stringify(draft) !== JSON.stringify(original);

	function commit(edit: Edit, select?: (rows: Row[]) => number) {
		if (!edit.ok) {
			setMessage({ text: edit.error, tone: 'hold' });
			return;
		}
		setDraft(edit.draft);
		if (select) {
			const target = select(buildRows(edit.draft, context, actionOnly));
			if (target >= 0) setSelected(target);
		}
	}

	function move(direction: -1 | 1) {
		let next = index + direction;
		while (next >= 0 && next < rows.length && !selectable(rows[next]!)) next += direction;
		if (next >= 0 && next < rows.length) setSelected(next);
	}

	const findPath = (kind: Row['kind'], path: Path) => (list: Row[]) =>
		list.findIndex((entry) => entry.kind === kind && 'path' in entry && samePath(entry.path, path));

	function apply() {
		if (preview.error) {
			setMessage({ text: `Fix this first: ${preview.error}`, tone: 'hold' });
			return;
		}
		const error = props.onApply(draft);
		if (error) setMessage({ text: error, tone: 'hold' });
	}

	function cancel() {
		if (changed) setOverlay({ kind: 'confirm', title: 'Discard the changes to this rule? y/n', lines: [{ text: 'Press y to discard, n to keep editing.' }], yes: props.onCancel });
		else props.onCancel();
	}

	function pickSubject(path: Path, current: Subject) {
		const options: Option[] = [];
		for (const [id, question] of Object.entries(context.questions ?? {})) {
			options.push({ label: `question  ${id}${typeof question.type === 'string' ? `  (${question.type})` : ''}`, value: { kind: 'question', name: id } });
		}
		for (const fact of context.facts) options.push({ label: `fact      ${fact}`, value: { kind: 'fact', name: fact } });
		options.push({ label: 'Type a fact path…', value: null, typed: { title: 'Fact path, for example grant.privileged', initial: current.kind === 'fact' ? current.name : '', parse: (text) => ({ kind: 'fact', name: text.trim() }) } });
		options.push({ label: 'Type a question id…', value: null, typed: { title: 'Question id', initial: current.kind === 'question' ? current.name : '', parse: (text) => ({ kind: 'question', name: text.trim() }) } });
		const found = options.findIndex((option) => isPlainObject(option.value) && option.value.kind === current.kind && option.value.name === current.name);
		openPicker('Check which question or fact?', options, Math.max(0, found), false, [], ([value]) => commit(setSubject(draft, path, value as Subject, context)));
	}

	function pickValue(path: Path, op: string, value: unknown, subject: Subject) {
		const set = (next: unknown) => commit(setOperatorValue(draft, path, op, next));
		const numeric = op.startsWith('confidence') || ['gte', 'gt', 'lte', 'lt'].includes(op);
		if (numeric) {
			// Probabilities and confidence live in 0–1, so thresholds outside that range are left out.
			const unit = op.startsWith('confidence') || subject.type === 'noul';
			const fits = ([, number]: [string, number]) => !unit || (number >= 0 && number <= 1);
			const options: Option[] = Object.entries(context.thresholds)
				.filter(fits)
				.map(([name, number]) => ({ label: `${name}  (${number})`, value: name }));
			options.push({ label: 'Type a number…', value: null, typed: { title: `${operatorWords(op, subject.type)}`, initial: typeof value === 'number' ? String(value) : '', parse: parseNumber } });
			const found = options.findIndex((option) => option.value === value);
			openPicker(`Compare with a threshold or a number · now ${valueText(value, op, context)}`, options, Math.max(0, found), false, [], ([next]) => set(next));
			return;
		}
		const list = op === 'in' || op === 'not_in';
		const labels = choiceLabels(subject, context);
		if (labels.length > 0) {
			const current = new Set(Array.isArray(value) ? value : [value]);
			const options = labels.map((label) => ({ label, value: label }));
			const chosen = labels.map((label, i) => (current.has(label) ? i : -1)).filter((i) => i >= 0);
			openPicker(list ? 'Choose labels: space marks, enter confirms' : 'Choose a label', options, Math.max(0, chosen[0] ?? 0), list, chosen, (values) => {
				if (list && values.length === 0) setMessage({ text: 'Choose at least one label.', tone: 'hold' });
				else set(list ? values : values[0]);
			});
			return;
		}
		if (list) {
			setOverlay({
				kind: 'prompt',
				title: 'Values as a JSON list, for example ["a", "b"] or [true]',
				initial: JSON.stringify(value),
				submit: (text) => {
					const parsed = parseTyped(text);
					if (!Array.isArray(parsed) || parsed.length === 0) setMessage({ text: 'Enter a non-empty JSON list.', tone: 'hold' });
					else set(parsed);
				},
			});
			return;
		}
		if (subject.kind === 'fact') {
			const options: Option[] = [
				{ label: 'true', value: true },
				{ label: 'false', value: false },
				{ label: 'null (the fact is known to be unset)', value: null },
				{ label: 'Type a value…', value: undefined, typed: { title: 'A number, true, false, null, or text', initial: JSON.stringify(value), parse: parseTyped } },
			];
			const found = options.findIndex((option) => option.value === value);
			openPicker('Compare the fact with', options, Math.max(0, found), false, [], ([next]) => set(next));
			return;
		}
		setOverlay({ kind: 'prompt', title: 'Choice label', initial: String(value ?? ''), submit: (text) => set(text) });
	}

	function openPicker(title: string, options: Option[], start: number, multi: boolean, chosen: number[], pick: (values: unknown[]) => void) {
		setOverlay({ kind: 'picker', title, options, index: start, multi, chosen: new Set(chosen), pick });
	}

	function onKey(key: KeyEvent) {
		if (overlay) return overlayKey(key, overlay, setOverlay, (text) => setMessage({ text, tone: 'hold' }));
		setMessage(null);
		if (key.ctrl && key.name === 's') return apply();
		if (key.name === 'escape') return cancel();
		const vertical = key.name === 'up' ? -1 : key.name === 'down' ? 1 : 0;
		const sideways = key.name === 'left' ? -1 : key.name === 'right' ? 1 : 0;
		if (vertical && !key.shift) return move(vertical);

		if (row.kind === 'field') {
			if (row.field === 'type' && sideways) return commit(cycleType(draft, sideways, context));
			if (key.name === 'return') {
				const field = row.field;
				setOverlay({ kind: 'prompt', title: FIELD_LABELS[field], initial: row.value, submit: (text) => commit(setField(draft, field, text)) });
			}
			return;
		}
		if (row.kind === 'gate') {
			if (sideways || key.name === 'space' || key.name === 'return') commit(toggleGate(draft));
			return;
		}
		if (row.kind === 'operator') {
			if (sideways) return commit(cycleOperator(draft, row.path, row.op, sideways, context));
			if (key.name === 'return') return pickValue(row.path, row.op, row.value, row.subject);
			if (key.name === 'x') return commit(deleteOperator(draft, row.path, row.op));
			return;
		}
		if (row.kind === 'add-operator') {
			if (key.name === 'return') commit(addOperator(draft, row.path, context));
			return;
		}
		if (row.kind === 'add-condition') {
			const groupPath = row.path;
			const mode = groupMode(draft, groupPath);
			const length = (asObject(at(draft, groupPath))[mode] as unknown[]).length;
			if (key.name === 'return' || key.name === 'a') return commit(addCondition(draft, groupPath, context), findPath('predicate', [...groupPath, mode, length]));
			if (key.name === 'g') return commit(addGroup(draft, groupPath, context), findPath('group', [...groupPath, mode, length]));
			return;
		}
		if (row.kind === 'group' || row.kind === 'predicate') {
			const path = row.path;
			if (row.kind === 'group' && (sideways || key.name === 'space')) return commit(toggleGroup(draft, path));
			if (row.kind === 'predicate' && key.name === 'return') return pickSubject(path, row.subject);
			if (key.name === 'x') return commit(deleteNode(draft, path));
			if (key.name === 'w') return commit(wrapInGroup(draft, path), findPath('group', path));
			if (vertical && key.shift) {
				const target = [...path.slice(0, -1), (path[path.length - 1] as number) + vertical];
				return commit(moveNode(draft, path, vertical), findPath(row.kind, target));
			}
			if (key.name === 'a' || key.name === 'g') {
				// Add next to this node. The top condition is wrapped in a group first.
				let base = draft;
				let nodePath = path;
				if (path.length === 1) {
					const wrapped = wrapInGroup(draft, path);
					if (!wrapped.ok) return commit(wrapped);
					base = wrapped.draft;
					nodePath = ['when', 'all', 0];
				}
				const groupPath = nodePath.slice(0, -2);
				const mode = groupMode(base, groupPath);
				const insertAt = (nodePath[nodePath.length - 1] as number) + 1;
				const edit = key.name === 'a' ? addCondition(base, groupPath, context, insertAt) : addGroup(base, groupPath, context, insertAt);
				return commit(edit, findPath(key.name === 'a' ? 'predicate' : 'group', [...groupPath, mode, insertAt]));
			}
		}
	}

	useKeyboard(onKey);

	const formWidth = Math.floor(props.width * 0.55);
	const bodyHeight = props.height - 2;
	const formLines = rows.map((entry, i) => rowLine(entry, context, i === index));
	const [start, end] = visibleWindow(formLines.length, index, bodyHeight - 2);

	return (
		<box style={{ flexDirection: 'column', width: props.width, height: props.height, backgroundColor: '#1a1b26' }}>
			<box style={{ flexDirection: 'row', height: bodyHeight }}>
				<box title={` ${actionOnly ? 'Edit the default action' : `Edit rule ${String(draft.id ?? '')}`}${changed ? ' · changed' : ''} `} style={{ border: true, borderColor: COLORS.focus, width: formWidth, height: bodyHeight, flexDirection: 'column', paddingLeft: 1, paddingRight: 1 }}>
					{formLines.slice(start, end).map((line, i) => (
						<text key={start + i} wrapMode="none" truncate fg={COLORS[line.tone ?? 'text']} bg={line.selected ? COLORS.selected : undefined}>
							{line.text}
						</text>
					))}
				</box>
				<box title=" Preview " style={{ border: true, borderColor: COLORS.border, width: props.width - formWidth, height: bodyHeight, flexDirection: 'column', paddingLeft: 1, paddingRight: 1 }}>
					{preview.lines(context, draft, props.width - formWidth - 4).slice(0, bodyHeight - 2).map((line, i) => (
						<text key={i} wrapMode="none" truncate fg={COLORS[line.tone ?? 'text']}>
							{line.text}
						</text>
					))}
				</box>
			</box>
			{message ? (
				<text wrapMode="word" style={{ height: 2 }} fg={COLORS[message.tone]}>
					{` ${message.text}`}
				</text>
			) : (
				<>
					<text wrapMode="none" truncate fg={COLORS.text}>
						{` ${ROW_HINTS[row.kind]}`}
					</text>
					<text wrapMode="none" truncate fg={COLORS.dim}>
						{' ↑↓ move · ctrl+s apply to the policy · esc cancel · the file is saved from the main screen'}
					</text>
				</>
			)}
			{overlay ? <OverlayBox overlay={overlay} width={props.width} height={props.height} close={() => setOverlay(null)} /> : null}
		</box>
	);
}

const FIELD_LABELS: Record<string, string> = {
	id: 'Rule id (no spaces)',
	description: 'Description (optional)',
	type: 'Action type, for example hold, block, or pass',
	target: 'Target, for example security or human',
	reason: 'Reason. {{answers.<id>.choice}}, {{thresholds.<name>}}, and {{facts.<path>}} are filled in.',
};

const ROW_HINTS: Record<Row['kind'], string> = {
	section: '',
	field: 'enter edit (on type: ←→ cycle common types)',
	gate: 'space or ←→ toggle: hold, or open the gate',
	group: 'space or ←→ all/any · a add condition · g add group · w wrap · x delete · shift+↑↓ move',
	predicate: 'enter choose question or fact · a add condition · g add group · w wrap · x delete · shift+↑↓ move',
	operator: '←→ change comparison · enter choose value · x remove',
	'add-operator': 'enter add another comparison (all must hold)',
	'add-condition': 'enter or a add a condition · g add a group',
};

function rowLine(row: Row, context: EditorContext, selected: boolean): Line {
	const pad = 'depth' in row ? '  '.repeat(row.depth + 1) : '';
	switch (row.kind) {
		case 'section':
			return { text: row.label, tone: 'accent' };
		case 'field':
			return { text: `  ${row.field.padEnd(12)} ${row.value || '(none)'}`, tone: row.value ? 'text' : 'dim', selected };
		case 'gate':
			return { text: `  ${'gate'.padEnd(12)} ${row.value ? '● holds' : '○ opens the gate'}`, tone: row.value ? 'hold' : 'open', selected };
		case 'group':
			return { text: `${pad}${row.mode === 'all' ? 'ALL of these' : 'ANY of these'}`, tone: 'accent', selected };
		case 'predicate':
			return { text: `${pad}${row.subject.kind} ${row.subject.name}${row.subject.type ? `  (${row.subject.type})` : ''}`, selected };
		case 'operator':
			return { text: `${pad}${operatorWords(row.op, row.subject.type)}  ${valueText(row.value, row.op, context)}`, selected };
		case 'add-operator':
			return { text: `${pad}+ add a comparison`, tone: 'dim', selected };
		case 'add-condition':
			return { text: `${pad}+ add a condition`, tone: 'dim', selected };
	}
}

// --- Preview ----------------------------------------------------------------

interface Preview {
	error?: string;
	lines: (context: EditorContext, draft: JsonObject, width: number) => Line[];
}

function previewFor(workspace: Workspace, derived: Derived, ruleIndex: number | 'default', draft: JsonObject): Preview {
	const candidate = clone(workspace.rules);
	if (ruleIndex === 'default') candidate.default_action = draft.action;
	else (candidate.rules as JsonObject[])[ruleIndex] = draft;
	const questions = questionMap(workspace);
	let error: string | undefined;
	try {
		validateRuleset(candidate);
		assertThresholdsResolve(candidate);
	} catch (caught) {
		error = (caught as Error).message;
	}
	const findings = error
		? []
		: lintRuleset(candidate, questions ? { questions } : {}).filter((finding) => (ruleIndex === 'default' ? finding.code === 'default-opens-gate' : finding.rule === draft.id));
	const diff = error ? undefined : diffPolicies(workspace.rules, candidate, derived.cases);
	return {
		...(error ? { error } : {}),
		lines(context, current, width) {
			const holds = isPlainObject(current.action) && current.action.gate === true;
			const lines: Line[] = [];
			describeRule(current, context, ruleIndex === 'default').forEach((sentence, i) => {
				// Wrap instead of truncating: this sentence is the point of the preview.
				// Continuation lines line up under the text, past the bullet.
				const [, lead = '', bullet = '', body = ''] = /^(\s*)(• )?(.*)$/.exec(sentence) ?? [];
				const hang = ' '.repeat(bullet.length);
				wrap(body, Math.max(10, width - lead.length - bullet.length)).forEach((chunk, part) => {
					lines.push({ text: `${lead}${part === 0 ? bullet : hang}${chunk}`, ...(i === 0 ? { tone: holds ? 'hold' : 'open' } : {}) });
				});
			});
			lines.push({ text: '' });
			if (error) {
				lines.push({ text: '✗ Not valid yet', tone: 'hold' });
				for (const chunk of wrap(error, width)) lines.push({ text: chunk, tone: 'hold' });
				return lines;
			}
			lines.push({ text: '✓ Valid', tone: 'open' });
			for (const finding of findings) for (const chunk of wrap(`${finding.severity}: ${finding.message}`, width)) lines.push({ text: chunk, tone: 'warn' });
			if (!diff || (diff.changes.length === 0 && diff.cases.length === 0)) {
				lines.push({ text: 'No change to the policy yet.', tone: 'dim' });
				return lines;
			}
			lines.push({ text: '' });
			for (const change of diff.changes) {
				const tone: Tone = change.effect === 'loosens' || change.effect === 'review' ? 'hold' : change.effect === 'tightens' ? 'open' : 'dim';
				for (const chunk of wrap(`${change.effect}: ${change.message}`, width)) lines.push({ text: chunk, tone });
			}
			if (diff.casesCompared > 0) {
				lines.push({ text: '' });
				lines.push({ text: `Cases that change: ${diff.cases.length} of ${diff.casesCompared}`, tone: 'accent' });
				for (const entry of diff.cases) {
					const before = entry.before.decision ? `${entry.before.decision.action}` : 'error';
					const after = entry.after.decision ? `${entry.after.decision.action}` : 'error';
					lines.push({ text: `${entry.opens ? '! ' : '  '}${entry.name}: ${before} → ${after}`, tone: entry.opens ? 'hold' : 'text' });
				}
			}
			return lines;
		},
	};
}

function editorContext(workspace: Workspace, derived: Derived): EditorContext {
	const facts = new Set<string>();
	const factSamples: Record<string, unknown> = {};
	for (const rule of derived.ruleset.rules) for (const fact of referencedFacts(rule.when)) facts.add(fact);
	const walk = (value: unknown, prefix: string) => {
		if (!isPlainObject(value)) {
			if (prefix) {
				facts.add(prefix);
				if (!(prefix in factSamples) || factSamples[prefix] === null) factSamples[prefix] = value;
			}
			return;
		}
		for (const [key, child] of Object.entries(value)) walk(child, prefix ? `${prefix}.${key}` : key);
	};
	for (const testCase of derived.cases) walk(testCase.facts ?? {}, '');
	const questions = questionMap(workspace);
	const factTypes: Record<string, string> = {};
	for (const [factPath, entry] of Object.entries(derived.ruleset.fact_schema ?? {})) factTypes[factPath] = entry.type;
	return {
		...(questions ? { questions } : {}),
		thresholds: derived.ruleset.thresholds,
		facts: [...facts].sort(),
		factSamples,
		factTypes,
		actionTypes: [...new Set(derived.ruleset.rules.map((rule) => rule.action.type))],
	};
}

// --- Helpers ----------------------------------------------------------------

function parseNumber(text: string): number | undefined {
	const value = Number(text.trim());
	return text.trim() !== '' && Number.isFinite(value) ? value : undefined;
}

function wrap(text: string, width: number): string[] {
	const out: string[] = [];
	let line = '';
	for (const word of text.split(/\s+/)) {
		if (line && line.length + word.length + 1 > width) {
			out.push(line);
			line = word;
		} else line = line ? `${line} ${word}` : word;
	}
	if (line) out.push(line);
	return out;
}

function clampSelectable(rows: Row[], index: number): number {
	let at = Math.min(Math.max(0, index), rows.length - 1);
	while (at < rows.length - 1 && !selectable(rows[at]!)) at++;
	return at;
}

function samePath(a: Path, b: Path): boolean {
	return a.length === b.length && a.every((part, i) => part === b[i]);
}

function asObject(value: unknown): JsonObject {
	return value as JsonObject;
}

function groupMode(draft: JsonObject, path: Path): 'all' | 'any' {
	return Array.isArray(asObject(at(draft, path)).all) ? 'all' : 'any';
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}
