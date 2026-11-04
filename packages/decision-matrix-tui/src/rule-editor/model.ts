import { isPlainObject, type LintQuestion } from 'decision-matrix-rules';

/**
 * A structured editor for one rule, as rows a person can move through.
 *
 * The draft is the rule's JSON, exactly as it will be saved. Each row points
 * at one part of it: a field of the action, a group of conditions, a
 * condition, or one comparison inside a condition. Every edit returns a new
 * draft. Nothing here validates the whole ruleset. The view does that on
 * every change and blocks applying an invalid rule.
 */

export type JsonObject = Record<string, unknown>;
export type Path = Array<string | number>;

export type Field = 'id' | 'description' | 'type' | 'target' | 'reason';

export type Row =
	| { kind: 'section'; label: string }
	| { kind: 'field'; field: Field; value: string }
	| { kind: 'gate'; value: boolean }
	| { kind: 'group'; path: Path; mode: 'all' | 'any'; depth: number; root: boolean }
	| { kind: 'predicate'; path: Path; subject: Subject; depth: number; root: boolean }
	| { kind: 'operator'; path: Path; op: string; value: unknown; subject: Subject; depth: number }
	| { kind: 'add-operator'; path: Path; depth: number }
	| { kind: 'add-condition'; path: Path; depth: number };

export interface Subject {
	kind: 'question' | 'fact';
	name: string;
	/** The question's type when the question set is known. */
	type?: string;
}

/** What the editor knows about the policy around the rule. */
export interface EditorContext {
	questions?: Record<string, LintQuestion>;
	thresholds: Record<string, number>;
	/** Fact paths seen in the ruleset and the cases, for the fact picker. */
	facts: string[];
	/** A value each fact has in the cases, so a new comparison can fit its type. */
	factSamples?: Record<string, unknown>;
	/** Action types used elsewhere in the ruleset, for cycling. */
	actionTypes: string[];
}

export type Edit = { ok: true; draft: JsonObject } | { ok: false; error: string };

const FIELDS: Field[] = ['id', 'description', 'type', 'target', 'reason'];
const COMMON_TYPES = ['hold', 'block', 'review', 'escalate', 'revoke', 'pass', 'allow', 'keep', 'auto_merge'];
const NUMERIC = ['gte', 'gt', 'lte', 'lt'];
const IDENTITY = ['eq', 'neq', 'in', 'not_in'];
const CONFIDENCE = ['confidence_gte', 'confidence_lt'];
const CONTAINS = ['contains', 'not_contains'];

export function selectable(row: Row): boolean {
	return row.kind !== 'section';
}

/**
 * `actionOnly` is for the default action: it has no id, description, or
 * condition, only what happens when no rule matches.
 */
export function buildRows(draft: JsonObject, context: EditorContext, actionOnly = false): Row[] {
	const action = isPlainObject(draft.action) ? draft.action : {};
	const rows: Row[] = actionOnly ? [] : [{ kind: 'section', label: 'Rule' }];
	for (const field of FIELDS) {
		if (actionOnly && (field === 'id' || field === 'description')) continue;
		const source = field === 'id' || field === 'description' ? draft[field] : action[field];
		if (field === 'type') rows.push({ kind: 'section', label: actionOnly ? 'When no rule matches' : 'Action' });
		rows.push({ kind: 'field', field, value: typeof source === 'string' ? source : '' });
	}
	rows.push({ kind: 'gate', value: action.gate === true });
	if (actionOnly) return rows;
	rows.push({ kind: 'section', label: 'When' });
	conditionRows(draft.when, ['when'], 0, true, context, rows);
	return rows;
}

function conditionRows(node: unknown, path: Path, depth: number, root: boolean, context: EditorContext, rows: Row[]): void {
	if (!isPlainObject(node)) return;
	const mode = Array.isArray(node.all) ? 'all' : Array.isArray(node.any) ? 'any' : undefined;
	if (mode) {
		rows.push({ kind: 'group', path, mode, depth, root });
		(node[mode] as unknown[]).forEach((child, index) => conditionRows(child, [...path, mode, index], depth + 1, false, context, rows));
		rows.push({ kind: 'add-condition', path, depth: depth + 1 });
		return;
	}
	const subject = subjectOf(node, context);
	rows.push({ kind: 'predicate', path, subject, depth, root });
	for (const op of operatorKeys(node)) {
		rows.push({ kind: 'operator', path, op, value: node[op], subject, depth: depth + 1 });
	}
	rows.push({ kind: 'add-operator', path, depth: depth + 1 });
}

function subjectOf(node: JsonObject, context: EditorContext): Subject {
	if (typeof node.fact === 'string') return { kind: 'fact', name: node.fact };
	const name = typeof node.question === 'string' ? node.question : '';
	const type = context.questions?.[name]?.type;
	return typeof type === 'string' ? { kind: 'question', name, type } : { kind: 'question', name };
}

function operatorKeys(node: JsonObject): string[] {
	return Object.keys(node).filter((key) => key !== 'question' && key !== 'fact');
}

/** Operators that make sense for a subject. An unknown question allows every question operator. */
export function validOperators(subject: Subject): string[] {
	if (subject.kind === 'fact') return [...IDENTITY, ...CONTAINS, ...NUMERIC];
	if (subject.type === 'choice') return [...IDENTITY, ...CONFIDENCE];
	if (subject.type === 'noul') return NUMERIC;
	if (subject.type === 'score') return [...NUMERIC, ...CONFIDENCE];
	return [...IDENTITY, ...NUMERIC, ...CONFIDENCE];
}

export function choiceLabels(subject: Subject, context: EditorContext): string[] {
	if (subject.kind !== 'question') return [];
	const criteria = context.questions?.[subject.name]?.criteria;
	return isPlainObject(criteria) ? Object.keys(criteria) : [];
}

/** A value that fits the operator, for a new comparison or a changed operator. */
export function defaultValue(op: string, subject: Subject, context: EditorContext): unknown {
	if (CONFIDENCE.includes(op)) return 'high_confidence' in context.thresholds ? 'high_confidence' : 0.85;
	const sample = subject.kind === 'fact' ? context.factSamples?.[subject.name] : undefined;
	if (NUMERIC.includes(op)) {
		if (subject.kind === 'fact') return typeof sample === 'number' ? sample : 0;
		return subject.type === 'score' ? 1 : 0.5;
	}
	const label = choiceLabels(subject, context)[0];
	const factScalar = sample === undefined || Array.isArray(sample) || isPlainObject(sample) ? true : sample;
	const scalar = subject.kind === 'fact' ? factScalar : (label ?? 'label');
	if (op === 'in' || op === 'not_in') return [scalar];
	return subject.kind === 'fact' && CONTAINS.includes(op) ? 'value' : scalar;
}

/** Keeps the value when it still fits the new operator, converting between one label and a list. */
function convertValue(value: unknown, from: string, to: string, subject: Subject, context: EditorContext): unknown {
	const numeric = (op: string) => NUMERIC.includes(op) || CONFIDENCE.includes(op);
	const list = (op: string) => op === 'in' || op === 'not_in';
	if (numeric(from) && numeric(to)) return value;
	if (!numeric(from) && !numeric(to)) {
		if (list(from) && !list(to)) return Array.isArray(value) && value.length > 0 ? value[0] : defaultValue(to, subject, context);
		if (!list(from) && list(to)) return [value];
		return value;
	}
	return defaultValue(to, subject, context);
}

// --- Edits ------------------------------------------------------------------

export function setField(draft: JsonObject, field: Field, value: string): Edit {
	const next = clone(draft);
	if (field === 'id') {
		if (value.trim() === '' || /\s/.test(value)) return { ok: false, error: 'A rule id cannot be empty or contain spaces.' };
		next.id = value;
	} else if (field === 'description') {
		if (value.trim() === '') delete next.description;
		else next.description = value;
	} else {
		if (value.trim() === '') return { ok: false, error: `The action ${field} cannot be empty.` };
		action(next)[field] = value;
	}
	return { ok: true, draft: next };
}

/** The next action type: the ruleset's own types first, then common ones. */
export function cycleType(draft: JsonObject, direction: -1 | 1, context: EditorContext): Edit {
	const types = [...new Set([...context.actionTypes, ...COMMON_TYPES])];
	const current = String(action(draft).type ?? '');
	const at = types.indexOf(current);
	const nextType = types[(at + direction + types.length) % types.length]!;
	return setField(draft, 'type', nextType);
}

export function toggleGate(draft: JsonObject): Edit {
	const next = clone(draft);
	action(next).gate = action(next).gate !== true;
	return { ok: true, draft: next };
}

export function toggleGroup(draft: JsonObject, path: Path): Edit {
	const next = clone(draft);
	const group = at(next, path) as JsonObject;
	const mode = Array.isArray(group.all) ? 'all' : 'any';
	const other = mode === 'all' ? 'any' : 'all';
	group[other] = group[mode];
	delete group[mode];
	return { ok: true, draft: next };
}

/** A new condition at the end of a group, on the first question (or a fact when there are none). */
export function addCondition(draft: JsonObject, groupPath: Path, context: EditorContext, index?: number): Edit {
	const next = clone(draft);
	const group = at(next, groupPath) as JsonObject;
	const list = (Array.isArray(group.all) ? group.all : group.any) as unknown[];
	list.splice(index ?? list.length, 0, newPredicate(context));
	return { ok: true, draft: next };
}

/** A nested "any of" group with one condition, after `index` in the parent group. */
export function addGroup(draft: JsonObject, groupPath: Path, context: EditorContext, index?: number): Edit {
	const next = clone(draft);
	const group = at(next, groupPath) as JsonObject;
	const list = (Array.isArray(group.all) ? group.all : group.any) as unknown[];
	list.splice(index ?? list.length, 0, { any: [newPredicate(context)] });
	return { ok: true, draft: next };
}

/** Puts a condition or group inside a new "all of" group, so siblings can be added next to it. */
export function wrapInGroup(draft: JsonObject, path: Path): Edit {
	const next = clone(draft);
	setAt(next, path, { all: [clone(at(next, path))] });
	return { ok: true, draft: next };
}

export function deleteNode(draft: JsonObject, path: Path): Edit {
	if (path.length === 1) return { ok: false, error: 'The top condition cannot be deleted. Change it instead.' };
	const next = clone(draft);
	const list = at(next, path.slice(0, -1)) as unknown[];
	if (list.length === 1) return { ok: false, error: 'A group needs at least one condition. Delete the group instead.' };
	list.splice(path[path.length - 1] as number, 1);
	return { ok: true, draft: next };
}

export function moveNode(draft: JsonObject, path: Path, direction: -1 | 1): Edit {
	if (path.length === 1) return { ok: false, error: 'The top condition has nothing to move past.' };
	const next = clone(draft);
	const list = at(next, path.slice(0, -1)) as unknown[];
	const index = path[path.length - 1] as number;
	const target = index + direction;
	if (target < 0 || target >= list.length) return { ok: false, error: 'Already at that end of the group.' };
	[list[index], list[target]] = [list[target], list[index]];
	return { ok: true, draft: next };
}

/**
 * Points a condition at another question or fact. Moving between questions of
 * the same type keeps the comparisons. Switching between a question and a
 * fact, or between question types, starts over with a comparison that fits.
 */
export function setSubject(draft: JsonObject, path: Path, subject: Subject, context: EditorContext): Edit {
	if (subject.name.trim() === '' || /\s/.test(subject.name)) return { ok: false, error: 'A question id or fact path cannot be empty or contain spaces.' };
	const next = clone(draft);
	const node = at(next, path) as JsonObject;
	const before = subjectOf(node, context);
	const resolved = subject.kind === 'question' ? subjectOf({ question: subject.name }, context) : subject;
	const sameKind = before.kind === resolved.kind && before.type === resolved.type;
	const valid = validOperators(resolved);
	const kept = sameKind ? operatorKeys(node).filter((op) => valid.includes(op)) : [];
	const rebuilt: JsonObject = { [resolved.kind]: resolved.name };
	for (const op of kept) rebuilt[op] = node[op];
	if (kept.length === 0) {
		const op = firstOperator(resolved, context);
		rebuilt[op] = defaultValue(op, resolved, context);
	}
	setAt(next, path, rebuilt);
	return { ok: true, draft: next };
}

/** A fact whose sample is a number starts with "is at least". Everything else starts with "is". */
function firstOperator(subject: Subject, context: EditorContext): string {
	if (subject.kind === 'fact' && typeof context.factSamples?.[subject.name] === 'number') return 'gte';
	return validOperators(subject)[0]!;
}

/** Switches the operator in place, keeping its position and, where it fits, its value. */
export function cycleOperator(draft: JsonObject, path: Path, op: string, direction: -1 | 1, context: EditorContext): Edit {
	const node = at(draft, path) as JsonObject;
	const subject = subjectOf(node, context);
	const used = new Set(operatorKeys(node));
	const choices = validOperators(subject).filter((candidate) => candidate === op || !used.has(candidate));
	const nextOp = choices[(choices.indexOf(op) + direction + choices.length) % choices.length]!;
	if (nextOp === op) return { ok: true, draft };
	const next = clone(draft);
	const rebuilt: JsonObject = {};
	for (const [key, value] of Object.entries(node)) {
		if (key === op) rebuilt[nextOp] = convertValue(value, op, nextOp, subject, context);
		else rebuilt[key] = value;
	}
	setAt(next, path, rebuilt);
	return { ok: true, draft: next };
}

export function setOperatorValue(draft: JsonObject, path: Path, op: string, value: unknown): Edit {
	const next = clone(draft);
	(at(next, path) as JsonObject)[op] = value;
	return { ok: true, draft: next };
}

/** Adds the first operator the condition does not use yet. Several operators on one condition must all hold. */
export function addOperator(draft: JsonObject, path: Path, context: EditorContext): Edit {
	const node = at(draft, path) as JsonObject;
	const subject = subjectOf(node, context);
	const used = new Set(operatorKeys(node));
	const op = validOperators(subject).find((candidate) => !used.has(candidate));
	if (!op) return { ok: false, error: 'This condition already uses every operator.' };
	return setOperatorValue(draft, path, op, defaultValue(op, subject, context));
}

export function deleteOperator(draft: JsonObject, path: Path, op: string): Edit {
	const node = at(draft, path) as JsonObject;
	if (operatorKeys(node).length === 1) return { ok: false, error: 'A condition needs a comparison. Delete the condition instead.' };
	const next = clone(draft);
	delete (at(next, path) as JsonObject)[op];
	return { ok: true, draft: next };
}

function newPredicate(context: EditorContext): JsonObject {
	const question = Object.keys(context.questions ?? {})[0];
	if (question) {
		const subject = subjectOf({ question }, context);
		const op = validOperators(subject)[0]!;
		return { question, [op]: defaultValue(op, subject, context) };
	}
	const fact = context.facts[0] ?? 'replace_me';
	const subject: Subject = { kind: 'fact', name: fact };
	const op = firstOperator(subject, context);
	return { fact, [op]: defaultValue(op, subject, context) };
}

// --- Plain-language summary -------------------------------------------------

const OP_WORDS: Record<string, string> = {
	eq: 'is',
	neq: 'is not',
	in: 'is one of',
	not_in: 'is none of',
	gte: 'is at least',
	gt: 'is more than',
	lte: 'is at most',
	lt: 'is less than',
	confidence_gte: 'has confidence at least',
	confidence_lt: 'has confidence below',
	contains: 'includes',
	not_contains: 'does not include',
};

export function operatorWords(op: string): string {
	return OP_WORDS[op] ?? op;
}

/** A value as a person reads it: a threshold shows its number. */
export function valueText(value: unknown, op: string, context: EditorContext): string {
	const numeric = NUMERIC.includes(op) || CONFIDENCE.includes(op);
	if (numeric && typeof value === 'string') {
		const name = /^\{\{\s*thresholds\.(\w+)\s*\}\}$/.exec(value)?.[1] ?? value;
		return name in context.thresholds ? `${name} (${context.thresholds[name]})` : `${name} (undefined threshold)`;
	}
	if (numeric && isPlainObject(value) && typeof value.threshold === 'string') {
		return `${value.threshold} (${context.thresholds[value.threshold] ?? 'undefined threshold'})`;
	}
	if (Array.isArray(value)) return value.map((entry) => JSON.stringify(entry)).join(', ');
	return JSON.stringify(value);
}

/** The rule as one sentence per line: what it does, then when. */
export function describeRule(draft: JsonObject, context: EditorContext, actionOnly = false): string[] {
	const act = isPlainObject(draft.action) ? draft.action : {};
	const what = `${act.gate === true ? 'Holds' : 'Opens the gate'}: ${String(act.type ?? '?')} → ${String(act.target ?? '?')}`;
	if (actionOnly) return [`When no rule matches, ${what.charAt(0).toLowerCase()}${what.slice(1)}`];
	const lines = [what, 'when'];
	describeCondition(draft.when, context, 1, lines);
	return lines;
}

function describeCondition(node: unknown, context: EditorContext, depth: number, lines: string[]): void {
	const pad = '  '.repeat(depth);
	if (!isPlainObject(node)) return;
	const mode = Array.isArray(node.all) ? 'all' : Array.isArray(node.any) ? 'any' : undefined;
	if (mode) {
		const children = node[mode] as unknown[];
		if (children.length === 1) return describeCondition(children[0], context, depth, lines);
		lines.push(`${pad}${mode === 'all' ? 'all of these are true:' : 'any of these is true:'}`);
		for (const child of children) describeCondition(child, context, depth + 1, lines);
		return;
	}
	const subject = subjectOf(node, context);
	const name = subject.kind === 'fact' ? `the fact ${subject.name}` : subject.name;
	const parts = operatorKeys(node).map((op) => `${operatorWords(op)} ${valueText(node[op], op, context)}`);
	lines.push(`${pad}• ${name} ${parts.join(' and ')}`);
}

// --- Helpers ----------------------------------------------------------------

function action(draft: JsonObject): JsonObject {
	if (!isPlainObject(draft.action)) draft.action = {};
	return draft.action as JsonObject;
}

export function at(root: unknown, path: Path): unknown {
	let node = root;
	for (const key of path) node = (node as Record<string | number, unknown>)[key];
	return node;
}

function setAt(root: JsonObject, path: Path, value: unknown): void {
	const parent = at(root, path.slice(0, -1)) as Record<string | number, unknown>;
	parent[path[path.length - 1]!] = value;
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}
