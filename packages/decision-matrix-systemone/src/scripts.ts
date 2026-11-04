import { describeValue, isPlainObject, type AnswerView } from 'decision-matrix-rules';

import { SystemOneError } from './errors';
import { readState } from './questions';

/**
 * Local answer scripts. `validateScripts` checks a version 1 document and
 * compiles it. `runScripts` reads the same state a server would, and returns
 * answer views for the questions that matched. The matchers are specified in
 * PROTOCOL.md so another host can produce the same answers.
 *
 * Needles are ASCII-lowercased once, here. A run lowercases the searched text
 * once, then each step scans it and stops when that question is answered.
 */

const FILE_KEYS = new Set(['$schema', 'version', 'scripts']);
const STEP_KEYS = new Set([
	'question',
	'description',
	'path',
	'contains',
	'word',
	'tag',
	'equals',
	'else',
	'choice',
	'noul',
	'score',
	'confidence',
]);
const MATCHERS = ['contains', 'word', 'tag', 'equals', 'else'] as const;
const ANSWERS = ['choice', 'noul', 'score'] as const;
const EQUALS_KEYS = new Set(['path', 'value']);
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const SEGMENT = /^(?:[A-Za-z_][A-Za-z0-9_-]*|0|[1-9][0-9]*)$/;

type Scalar = string | number | boolean | null;

interface CompiledStep {
	question: string;
	isElse: boolean;
	matches: (view: StateView) => boolean;
	answer: AnswerView;
}

interface FieldText {
	text: string | undefined;
}

interface StateView {
	/** ASCII-lowercased search text. Empty when the state has no string leaves. */
	text: string;
	isString: boolean;
	root: unknown;
	fields: Map<string, FieldText>;
}

/** A compiled script. Build one with `validateScripts` and reuse it across events. */
export class ScriptProgram {
	constructor(readonly steps: readonly CompiledStep[]) {}
}

/**
 * Checks a scripts document. With `questions`, each step must name one of
 * those questions and answer with its type. A choice label must be one that
 * question offers, and a score must be one of its levels.
 */
export function validateScripts(value: unknown, questions?: object): ScriptProgram {
	if (!isPlainObject(value)) {
		throw new SystemOneError(`Scripts must be a JSON object with version and scripts. Received ${describeValue(value)}.`);
	}
	assertKnownKeys(value, FILE_KEYS, 'scripts');
	if (value.$schema !== undefined && typeof value.$schema !== 'string') {
		throw new SystemOneError('scripts.$schema must be a string.');
	}
	if (value.version !== 1) {
		throw new SystemOneError(`Scripts version must be 1. Received ${JSON.stringify(value.version)}.`);
	}
	if (!Array.isArray(value.scripts) || value.scripts.length === 0) {
		throw new SystemOneError('scripts must be a non-empty array of steps.');
	}
	const expected = questions === undefined ? undefined : expectQuestions(questions);
	const steps = value.scripts.map((step, index) => compileStep(step, index, expected));
	assertElseIsLast(steps);
	return new ScriptProgram(steps);
}

/** Answers for the questions whose steps matched. Other questions are absent. */
export function runScripts(program: ScriptProgram, state: unknown): Record<string, AnswerView> {
	if (!(program instanceof ScriptProgram)) {
		throw new SystemOneError('runScripts expects the program returned by validateScripts.');
	}
	const view = buildView(readState(state));
	const answers: Record<string, AnswerView> = {};
	for (const step of program.steps) {
		if (Object.prototype.hasOwnProperty.call(answers, step.question)) continue;
		if (step.matches(view)) answers[step.question] = step.answer;
	}
	return answers;
}

/** Questions with no entry in `answers`, in the question set's order. */
export function unansweredQuestions(
	questions: Record<string, unknown>,
	answers: Record<string, AnswerView>,
): Record<string, unknown> {
	const remaining: Record<string, unknown> = {};
	for (const [id, question] of Object.entries(questions)) {
		if (!Object.prototype.hasOwnProperty.call(answers, id)) remaining[id] = question;
	}
	return remaining;
}

interface ExpectedQuestion {
	type: 'choice' | 'noul' | 'score';
	labels?: ReadonlySet<string>;
	levels?: number;
}

function expectQuestions(questions: object): Map<string, ExpectedQuestion> {
	if (!isPlainObject(questions)) {
		throw new SystemOneError(`Questions passed to validateScripts must be an object. Received ${describeValue(questions)}.`);
	}
	const expected = new Map<string, ExpectedQuestion>();
	for (const [id, question] of Object.entries(questions)) {
		if (id === '$schema') continue;
		expected.set(id, expectQuestion(id, question));
	}
	return expected;
}

function expectQuestion(id: string, question: unknown): ExpectedQuestion {
	const path = `questions.${id}`;
	if (!isPlainObject(question)) throw new SystemOneError(`${path} must be an object.`);
	if (question.type !== 'choice' && question.type !== 'noul' && question.type !== 'score') {
		throw new SystemOneError(`${path}.type must be "choice", "noul", or "score".`);
	}
	if (question.type === 'noul') return { type: 'noul' };
	if (question.type === 'score') {
		if (!Array.isArray(question.criteria) || question.criteria.length < 2) {
			throw new SystemOneError(`${path}.criteria must list the score levels a script compares against.`);
		}
		return { type: 'score', levels: question.criteria.length };
	}
	const labels = labelsOf(question.criteria);
	if (labels.size === 0) throw new SystemOneError(`${path}.criteria must list the choice labels a script compares against.`);
	return { type: 'choice', labels };
}

function labelsOf(criteria: unknown): Set<string> {
	if (Array.isArray(criteria)) {
		return new Set(criteria.filter((label): label is string => typeof label === 'string' && label !== ''));
	}
	if (isPlainObject(criteria)) return new Set(Object.keys(criteria).filter((label) => label !== ''));
	return new Set();
}

function compileStep(value: unknown, index: number, expected: Map<string, ExpectedQuestion> | undefined): CompiledStep {
	const path = `scripts[${index}]`;
	if (!isPlainObject(value)) throw new SystemOneError(`${path} must be an object.`);
	assertKnownKeys(value, STEP_KEYS, path);
	if (typeof value.question !== 'string' || !/^\S+$/.test(value.question)) {
		throw new SystemOneError(`${path}.question must be a non-empty string without spaces.`);
	}
	if (value.description !== undefined && typeof value.description !== 'string') {
		throw new SystemOneError(`${path}.description must be a string.`);
	}
	const matcher = oneOf(value, MATCHERS, path, 'matcher: contains, word, tag, equals, or else');
	const answerKind = oneOf(value, ANSWERS, path, 'answer: choice, noul, or score');
	const paths = readStepPaths(value.path, matcher, `${path}.path`);
	const answer = readAnswer(value, answerKind, path);
	const spec = expected?.get(value.question);
	if (expected && spec === undefined) {
		throw new SystemOneError(`${path}.question "${value.question}" is not in the question set.`);
	}
	if (spec) checkAnswerFits(spec, answer, value.question, path);
	return {
		question: value.question,
		isElse: matcher === 'else',
		matches: compileMatch(matcher, value, paths, path),
		answer,
	};
}

function oneOf(step: Record<string, unknown>, names: readonly string[], path: string, label: string): string {
	const present = names.filter((name) => step[name] !== undefined);
	if (present.length !== 1) {
		const found = present.length === 0 ? 'none' : present.map((name) => `"${name}"`).join(' and ');
		throw new SystemOneError(`${path} must have one ${label}. Found ${found}.`);
	}
	return present[0]!;
}

function readStepPaths(value: unknown, matcher: string, path: string): string[][] | undefined {
	if (value === undefined) return undefined;
	if (matcher === 'else' || matcher === 'equals') {
		throw new SystemOneError(`${path} is used with contains, word, and tag. ${matcher} carries its own place to look.`);
	}
	return readPaths(value, path);
}

function readPaths(value: unknown, path: string): string[][] {
	if (typeof value === 'string') return [readPath(value, path)];
	if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length) {
		throw new SystemOneError(`${path} must be a dotted path or a list of different paths.`);
	}
	return value.map((item, index) => readPath(item, `${path}[${index}]`));
}

function readPath(value: unknown, path: string): string[] {
	if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
		throw new SystemOneError(`${path} must be a dotted path.`);
	}
	const segments = value.split('.');
	if (segments.length > 32) throw new SystemOneError(`${path} "${value}" nests more than 32 segments.`);
	for (const segment of segments) {
		if (!SEGMENT.test(segment) || RESERVED.has(segment)) {
			throw new SystemOneError(`${path} "${value}" must be a dotted path of names or array indexes.`);
		}
	}
	return segments;
}

function readAnswer(step: Record<string, unknown>, kind: string, path: string): AnswerView {
	const confidence = step.confidence;
	if (kind === 'noul') {
		if (confidence !== undefined) throw new SystemOneError(`${path}.confidence is not used on a noul answer.`);
		return { type: 'noul', noul: readUnit(step.noul, `${path}.noul`) };
	}
	const unit = readUnit(confidence, `${path}.confidence`);
	if (kind === 'choice') {
		if (typeof step.choice !== 'string' || !/\S/.test(step.choice)) {
			throw new SystemOneError(`${path}.choice must be a non-empty label.`);
		}
		return {
			type: 'choice',
			choice: step.choice,
			confidence: unit,
			probabilities: { [step.choice]: unit },
		};
	}
	if (typeof step.score !== 'number' || !Number.isInteger(step.score) || step.score < 0) {
		throw new SystemOneError(`${path}.score must be an integer level, 0 or higher.`);
	}
	return {
		type: 'score',
		score: step.score,
		confidence: unit,
		probabilities: { [String(step.score)]: unit },
	};
}

function readUnit(value: unknown, path: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
		throw new SystemOneError(`${path} must be a number from 0 to 1.`);
	}
	return value;
}

function checkAnswerFits(spec: ExpectedQuestion, answer: AnswerView, id: string, path: string): void {
	if (answer.type !== spec.type) {
		throw new SystemOneError(`${path} answers ${answer.type}, and question "${id}" is a ${spec.type}.`);
	}
	if (answer.type === 'choice' && spec.labels && !spec.labels.has(answer.choice ?? '')) {
		throw new SystemOneError(`${path}.choice "${answer.choice ?? ''}" is not a label of question "${id}".`);
	}
	if (answer.type === 'score' && spec.levels !== undefined && (answer.score ?? -1) >= spec.levels) {
		throw new SystemOneError(
			`${path}.score ${String(answer.score)} is outside question "${id}", whose levels are 0 to ${spec.levels - 1}.`,
		);
	}
}

function compileMatch(matcher: string, step: Record<string, unknown>, paths: string[][] | undefined, path: string): (view: StateView) => boolean {
	if (matcher === 'else') {
		if (step.else !== true) throw new SystemOneError(`${path}.else must be true.`);
		return () => true;
	}
	if (matcher === 'equals') return compileEquals(step.equals, path);
	const needles = readNeedles(step[matcher], `${path}.${matcher}`);
	if (matcher === 'contains') return (view) => texts(view, paths, false).some((text) => needles.some((needle) => text.includes(needle)));
	if (matcher === 'word') return (view) => texts(view, paths, false).some((text) => needles.some((needle) => hasWord(text, needle)));
	return (view) => texts(view, paths, true).some((text) => needles.some((needle) => hasTag(text, needle)));
}

function compileEquals(value: unknown, path: string): (view: StateView) => boolean {
	const at = `${path}.equals`;
	if (!isPlainObject(value)) throw new SystemOneError(`${at} must be an object with path and value.`);
	assertKnownKeys(value, EQUALS_KEYS, at);
	const segments = readPath(value.path, `${at}.path`);
	const expected = readScalar(value.value, `${at}.value`);
	return (view) => lookup(view.root, segments) === expected;
}

function readScalar(value: unknown, path: string): Scalar {
	if (typeof value === 'string' || typeof value === 'boolean' || value === null) return value;
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	throw new SystemOneError(`${path} must be a string, number, boolean, or null.`);
}

function readNeedles(value: unknown, path: string): string[] {
	const list = typeof value === 'string' ? [value] : value;
	if (!Array.isArray(list) || list.length === 0 || new Set(list).size !== list.length) {
		throw new SystemOneError(`${path} must be a non-empty string or a list of different ones.`);
	}
	return list.map((needle, index) => {
		if (typeof needle !== 'string' || needle.trim() === '' || !/\S/.test(needle)) {
			throw new SystemOneError(`${path}[${index}] must be a non-empty string.`);
		}
		return asciiLower(needle);
	});
}

function assertElseIsLast(steps: CompiledStep[]): void {
	const elseAt = new Map<string, number>();
	steps.forEach((step, index) => {
		const earlier = elseAt.get(step.question);
		if (earlier !== undefined) {
			throw new SystemOneError(
				`scripts[${index}] follows else for "${step.question}" at scripts[${earlier}]. else must be the last step for that question.`,
			);
		}
		if (step.isElse) elseAt.set(step.question, index);
	});
}

function assertKnownKeys(input: Record<string, unknown>, allowed: Set<string>, path: string): void {
	for (const key of Object.keys(input)) {
		if (!allowed.has(key)) {
			throw new SystemOneError(`${path} has unknown key "${key}". Expected: ${[...allowed].join(', ')}.`);
		}
	}
}

function buildView(state: unknown): StateView {
	const leaves: string[] = [];
	collectLeaves(state, leaves);
	return {
		text: asciiLower(leaves.join('\n')),
		isString: typeof state === 'string',
		root: state,
		fields: new Map(),
	};
}

function collectLeaves(value: unknown, leaves: string[]): void {
	if (typeof value === 'string') {
		leaves.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectLeaves(item, leaves);
		return;
	}
	if (isPlainObject(value)) {
		for (const key of Object.keys(value).sort()) collectLeaves(value[key], leaves);
	}
}

/** `tag` on an object looks only at `paths`. A scan with no path uses the joined text. */
function texts(view: StateView, paths: string[][] | undefined, tag: boolean): string[] {
	if (paths === undefined) {
		if (tag) return view.isString && view.text !== '' ? [view.text] : [];
		return view.text === '' ? [] : [view.text];
	}
	const found: string[] = [];
	for (const segments of paths) {
		const text = fieldText(view, segments);
		if (text) found.push(text);
	}
	return found;
}

function fieldText(view: StateView, segments: string[]): string | undefined {
	const key = segments.join('\0');
	const cached = view.fields.get(key);
	if (cached) return cached.text;
	const value = lookup(view.root, segments);
	const text = typeof value === 'string' ? asciiLower(value) : undefined;
	view.fields.set(key, { text });
	return text;
}

function lookup(root: unknown, segments: string[]): unknown {
	let current: unknown = root;
	for (const segment of segments) {
		if (RESERVED.has(segment)) return undefined;
		if (Array.isArray(current)) {
			if (!SEGMENT.test(segment)) return undefined;
			const index = Number(segment);
			if (!Object.prototype.hasOwnProperty.call(current, index)) return undefined;
			current = current[index];
			continue;
		}
		if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
		current = current[segment];
	}
	return current;
}

function hasWord(haystack: string, needle: string): boolean {
	let from = 0;
	while (from <= haystack.length - needle.length) {
		const at = haystack.indexOf(needle, from);
		if (at < 0) return false;
		const before = at === 0 || !isWordChar(haystack.charCodeAt(at - 1));
		const after = at + needle.length;
		const afterOk = after === haystack.length || !isWordChar(haystack.charCodeAt(after));
		if (before && afterOk) return true;
		from = at + 1;
	}
	return false;
}

/** A leading token whose next character is `:` or `(`. */
function hasTag(haystack: string, needle: string): boolean {
	if (!haystack.startsWith(needle)) return false;
	const next = haystack.charCodeAt(needle.length);
	return next === 58 || next === 40;
}

function isWordChar(code: number): boolean {
	return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

function asciiLower(value: string): string {
	return value.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}
