import type { KeyEvent } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useState } from 'react';

import { isPlainObject } from 'decision-matrix-rules';

import { questionMap, type Derived, type EditResult, type JsonObject, type Workspace } from '../model';
import { OverlayBox, overlayKey, picker, type Overlay } from '../overlay';
import {
	QUESTION_TYPES,
	addLabel,
	addLevel,
	addQuestion,
	deleteLabel,
	deleteLevel,
	deleteQuestion,
	labelsOf,
	moveLevel,
	questionUsers,
	renameLabel,
	renameQuestion,
	setInstructions,
	setLabelDescription,
	setLevel,
	setQuestionType,
	type QuestionType,
} from '../questions-model';
import { COLORS, Pane, type Line, type Tone } from '../views';

type Row =
	| { kind: 'id' | 'type' | 'instructions' }
	| { kind: 'section'; label: string }
	| { kind: 'label'; label: string; description: string | null }
	| { kind: 'level'; index: number; text: string }
	| { kind: 'add-label' | 'add-level' };

export interface QuestionsEditorProps {
	workspace: Workspace;
	derived: Derived;
	width: number;
	height: number;
	/** Applies an edit to the workspace. Returns false and shows the error when it was refused. */
	apply: (result: EditResult, done?: string) => boolean;
	onClose: () => void;
	onSave: () => void;
}

const LINT_CODES = new Set(['unknown-question', 'unknown-label', 'operator-type', 'out-of-range', 'unused-question']);

const HINTS: Record<string, string> = {
	list: '↑↓ select · enter or tab edit · n new question · r rename · x delete',
	id: 'enter rename (rules and cases follow)',
	type: '←→ change the type',
	instructions: 'enter edit what the model is asked',
	label: 'enter describe · r rename (rules and cases follow) · x delete',
	level: 'enter edit · shift+↑↓ move · x delete',
	'add-label': 'enter add a label',
	'add-level': 'enter add a level',
	section: '',
};

export function QuestionsEditor(props: QuestionsEditorProps) {
	const { workspace, derived, apply } = props;
	const questions = questionMap(workspace) ?? {};
	const ids = Object.keys(questions);
	const [focus, setFocus] = useState<'list' | 'detail'>('list');
	const [listIndex, setListIndex] = useState(0);
	const [detailIndex, setDetailIndex] = useState(0);
	const [overlay, setOverlay] = useState<Overlay | null>(null);
	const [message, setMessage] = useState<{ text: string; tone: Tone } | null>(null);

	const selectedIndex = Math.min(listIndex, Math.max(0, ids.length));
	const id = ids[selectedIndex];
	const entry = id ? (questions[id] as JsonObject) : undefined;
	const rows = entry ? detailRows(entry) : [];
	const rowIndex = clampRow(rows, detailIndex);
	const row = rows[rowIndex];

	/** Applies an edit and reports it here, since the main screen's status line is not visible. */
	function run(result: EditResult, done?: string, after?: () => void) {
		if (apply(result)) {
			if (done) setMessage({ text: done, tone: 'open' });
			after?.();
		} else if (!result.ok) setMessage({ text: result.error, tone: 'hold' });
	}

	function prompt(title: string, initial: string, submit: (text: string) => void) {
		setOverlay({ kind: 'prompt', title, initial, submit });
	}

	function newQuestion() {
		setOverlay(
			picker(
				'What kind of question?',
				[
					{ label: 'choice  — the model picks one label', value: 'choice' },
					{ label: 'noul    — the model rates a statement from 0 (false) to 1 (true)', value: 'noul' },
					{ label: 'score   — the model picks a level, lowest first', value: 'score' },
				],
				(type) =>
					prompt('Question id (no spaces)', '', (text) =>
						run(addQuestion(workspace, text.trim(), type as QuestionType), `Added ${text.trim()}.`, () => setListIndex(ids.length)),
					),
			),
		);
	}

	function onListKey(key: KeyEvent) {
		const vertical = key.name === 'up' ? -1 : key.name === 'down' ? 1 : 0;
		if (vertical) return setListIndex(Math.min(Math.max(0, selectedIndex + vertical), ids.length));
		if (key.name === 'n' || (key.name === 'return' && !id)) return newQuestion();
		if (!id) return;
		if (key.name === 'return' || key.name === 'tab') return setFocus('detail');
		if (key.name === 'r') return prompt(`Rename ${id} to`, id, (text) => run(renameQuestion(workspace, id, text.trim()), `Renamed to ${text.trim()}. Rules and cases follow.`));
		if (key.name === 'x') {
			setOverlay({
				kind: 'confirm',
				title: `Delete question ${id}? y/n`,
				lines: [{ text: 'Its saved answers in the cases are removed too.' }],
				yes: () => run(deleteQuestion(workspace, id), `Deleted ${id}.`),
			});
		}
	}

	function onDetailKey(key: KeyEvent) {
		if (!id || !entry || !row) return;
		const vertical = key.name === 'up' ? -1 : key.name === 'down' ? 1 : 0;
		if (vertical && !key.shift) {
			let next = rowIndex + vertical;
			while (next >= 0 && next < rows.length && rows[next]!.kind === 'section') next += vertical;
			if (next >= 0 && next < rows.length) setDetailIndex(next);
			return;
		}
		if (key.name === 'tab') return setFocus('list');
		const sideways = key.name === 'left' ? -1 : key.name === 'right' ? 1 : 0;
		switch (row.kind) {
			case 'id':
				if (key.name === 'return') prompt(`Rename ${id} to`, id, (text) => run(renameQuestion(workspace, id, text.trim()), 'Renamed. Rules and cases follow.'));
				return;
			case 'type':
				if (sideways) {
					const at = QUESTION_TYPES.indexOf(entry.type as QuestionType);
					const next = QUESTION_TYPES[(at + sideways + QUESTION_TYPES.length) % QUESTION_TYPES.length]!;
					run(setQuestionType(workspace, id, next), `${id} is now a ${next} question. Check the lint for rules that no longer fit.`);
				}
				return;
			case 'instructions':
				if (key.name === 'return') prompt('What the model is asked', String(entry.instructions ?? ''), (text) => run(setInstructions(workspace, id, text)));
				return;
			case 'label': {
				const label = row.label;
				if (key.name === 'return') prompt(`Describe ${label} (empty for none)`, row.description ?? '', (text) => run(setLabelDescription(workspace, id, label, text)));
				else if (key.name === 'r') prompt(`Rename ${label} to`, label, (text) => run(renameLabel(workspace, id, label, text.trim()), 'Renamed. Rules and cases follow.'));
				else if (key.name === 'x') run(deleteLabel(workspace, id, label), `Deleted ${label}.`);
				return;
			}
			case 'level': {
				const index = row.index;
				if (key.name === 'return') prompt(`Level ${index}`, row.text, (text) => run(setLevel(workspace, id, index, text)));
				else if (key.name === 'x') run(deleteLevel(workspace, id, index), 'Deleted. Score numbers above it moved down by one, so check rules on this question.');
				else if (vertical && key.shift) run(moveLevel(workspace, id, index, vertical), 'Moved. Score numbers changed meaning, so check rules on this question.', () => setDetailIndex(rowIndex + vertical));
				return;
			}
			case 'add-label':
				if (key.name === 'return') prompt('New label', '', (text) => run(addLabel(workspace, id, text.trim()), `Added ${text.trim()}.`));
				return;
			case 'add-level':
				if (key.name === 'return') prompt('New highest level', '', (text) => run(addLevel(workspace, id, text), 'Added a level.'));
				return;
		}
	}

	function onKey(key: KeyEvent) {
		if (overlay) return overlayKey(key, overlay, setOverlay, (text) => setMessage({ text, tone: 'hold' }));
		setMessage(null);
		if (key.ctrl && key.name === 's') return props.onSave();
		if (key.name === 'escape') {
			if (focus === 'detail') return setFocus('list');
			return props.onClose();
		}
		if (focus === 'list') onListKey(key);
		else onDetailKey(key);
	}

	useKeyboard(onKey);

	const findings = derived.findings.filter((finding) => LINT_CODES.has(finding.code));
	const bodyHeight = props.height - 2 - Math.min(6, findings.length + (findings.length > 0 ? 2 : 0));
	const listLines: Line[] = ids.map((questionId, i) => {
		const users = questionUsers(workspace, questionId).length;
		return {
			text: `${questionId}  ${String((questions[questionId] as JsonObject).type)}  · ${users === 0 ? 'unused' : `${users} rule${users === 1 ? '' : 's'}`}`,
			tone: users === 0 ? 'dim' : 'text',
			selected: i === selectedIndex,
		};
	});
	listLines.push({ text: '+ add a question', tone: 'dim', selected: selectedIndex === ids.length });
	const detailLines: Line[] = entry ? rows.map((entryRow, i) => rowLine(entryRow, id!, entry, focus === 'detail' && i === rowIndex)) : [{ text: 'Select a question, or add one.', tone: 'dim' }];
	const hint = focus === 'list' ? HINTS.list : HINTS[row?.kind ?? 'section'];

	return (
		<box style={{ flexDirection: 'column', width: props.width, height: props.height, backgroundColor: '#1a1b26' }}>
			<box style={{ flexDirection: 'row', height: bodyHeight }}>
				<Pane title={` Questions · ${workspace.questionsPath ?? ''} `} focused={focus === 'list'} width="40%" height={bodyHeight} lines={listLines} selectedIndex={selectedIndex} />
				<Pane title={` ${id ?? 'Question'} `} focused={focus === 'detail'} width="60%" height={bodyHeight} lines={detailLines} selectedIndex={rowIndex} />
			</box>
			{findings.length > 0 ? (
				<box title={` Lint · ${findings.length} `} style={{ border: true, borderColor: COLORS.border, height: Math.min(6, findings.length + 2), flexDirection: 'column', paddingLeft: 1 }}>
					{findings.slice(0, 4).map((finding, i) => (
						<text key={i} wrapMode="none" truncate fg={finding.severity === 'error' ? COLORS.hold : finding.severity === 'warning' ? COLORS.warn : COLORS.dim}>
							{`${finding.severity}: ${finding.message}`}
						</text>
					))}
				</box>
			) : null}
			{message ? (
				<text wrapMode="word" style={{ height: 2 }} fg={COLORS[message.tone]}>
					{` ${message.text}`}
				</text>
			) : (
				<>
					<text wrapMode="none" truncate fg={COLORS.text}>
						{` ${hint}`}
					</text>
					<text wrapMode="none" truncate fg={COLORS.dim}>
						{' tab list/detail · esc back · ctrl+s save · edits apply at once and carry into rules and cases'}
					</text>
				</>
			)}
			{overlay ? <OverlayBox overlay={overlay} width={props.width} height={props.height} close={() => setOverlay(null)} /> : null}
		</box>
	);
}

function detailRows(entry: JsonObject): Row[] {
	const rows: Row[] = [{ kind: 'id' }, { kind: 'type' }, { kind: 'instructions' }];
	if (entry.type === 'choice') {
		rows.push({ kind: 'section', label: 'Labels' });
		const descriptions = isPlainObject(entry.criteria) ? entry.criteria : {};
		for (const label of labelsOf(entry)) {
			const description = descriptions[label];
			rows.push({ kind: 'label', label, description: typeof description === 'string' ? description : null });
		}
		rows.push({ kind: 'add-label' });
	} else if (entry.type === 'score') {
		rows.push({ kind: 'section', label: 'Levels, lowest (0) first' });
		(entry.criteria as string[]).forEach((text, index) => rows.push({ kind: 'level', index, text }));
		rows.push({ kind: 'add-level' });
	}
	return rows;
}

function rowLine(row: Row, id: string, entry: JsonObject, selected: boolean): Line {
	switch (row.kind) {
		case 'id':
			return { text: `  id            ${id}`, selected };
		case 'type':
			return { text: `  type          ${String(entry.type)}`, tone: 'accent', selected };
		case 'instructions':
			return { text: `  instructions  ${String(entry.instructions ?? '')}`, selected };
		case 'section':
			return { text: row.label, tone: 'accent' };
		case 'label':
			return { text: `    ${row.label}${row.description ? `  — ${row.description}` : ''}`, selected };
		case 'level':
			return { text: `    ${row.index}  ${row.text}`, selected };
		case 'add-label':
			return { text: '    + add a label', tone: 'dim', selected };
		case 'add-level':
			return { text: '    + add a level', tone: 'dim', selected };
	}
}

function clampRow(rows: Row[], index: number): number {
	if (rows.length === 0) return 0;
	let at = Math.min(Math.max(0, index), rows.length - 1);
	while (at < rows.length - 1 && rows[at]!.kind === 'section') at++;
	return at;
}
