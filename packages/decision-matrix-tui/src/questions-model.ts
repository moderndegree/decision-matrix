import { isPlainObject, referencedQuestions, validateRuleset } from 'decision-matrix-rules';

import { editDocuments, questionMap, renameKey, type EditResult, type JsonObject, type Workspace } from './model';

/**
 * Edits to the questions file. Renames carry through: a question id is
 * renamed in every rule, template, and case answer that uses it, and a choice
 * label is renamed in every rule comparison and saved choice. Deleting a
 * question or label that a rule still reads is refused, naming the rules.
 */

export type QuestionType = 'choice' | 'noul' | 'score';
export const QUESTION_TYPES: QuestionType[] = ['choice', 'noul', 'score'];

const ID = /^\S+$/;
const IDENTITY_KEYS = ['eq', 'neq', 'in', 'not_in'];

function requireQuestions(workspace: Workspace): EditResult | undefined {
	return workspace.questions ? undefined : { ok: false, error: 'No questions file is open. Start with --questions <file>.' };
}

function question(docs: { questions?: JsonObject }, id: string): JsonObject {
	const entry = docs.questions?.[id];
	if (!isPlainObject(entry)) throw new Error(`There is no question ${id}.`);
	return entry;
}

/** Every predicate object in the rules, wherever it sits in a condition tree. */
function predicates(rules: JsonObject): JsonObject[] {
	const found: JsonObject[] = [];
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) return node.forEach(walk);
		if (!isPlainObject(node)) return;
		if (typeof node.question === 'string') found.push(node);
		for (const value of Object.values(node)) walk(value);
	};
	for (const rule of rules.rules as JsonObject[]) walk(rule.when);
	return found;
}

/** The defaults and every case in the cases file. */
function caseParts(cases: JsonObject | undefined): JsonObject[] {
	if (!cases) return [];
	return [cases.defaults, ...(cases.cases as unknown[])].filter(isPlainObject);
}

/** Every answers map in the cases file: the defaults' and each case's. */
function answerMaps(cases: JsonObject | undefined): JsonObject[] {
	return caseParts(cases).map((part) => part.answers).filter(isPlainObject);
}

/** The ids of rules that read the question. */
export function questionUsers(workspace: Workspace, id: string): string[] {
	return validateRuleset(workspace.rules)
		.rules.filter((rule) => referencedQuestions(rule.when).includes(id))
		.map((rule) => rule.id);
}

/** The ids of rules that compare the question with the label. */
export function labelUsers(workspace: Workspace, id: string, label: string): string[] {
	const users: string[] = [];
	for (const rule of workspace.rules.rules as JsonObject[]) {
		const uses = predicates({ rules: [rule] }).some(
			(node) => node.question === id && IDENTITY_KEYS.some((key) => (Array.isArray(node[key]) ? (node[key] as unknown[]).includes(label) : node[key] === label)),
		);
		if (uses) users.push(String(rule.id));
	}
	return users;
}

export function labelsOf(entry: JsonObject): string[] {
	return isPlainObject(entry.criteria) ? Object.keys(entry.criteria) : Array.isArray(entry.criteria) ? (entry.criteria as string[]) : [];
}

const STARTERS: Record<QuestionType, () => JsonObject> = {
	choice: () => ({ type: 'choice', instructions: 'What to ask the model', criteria: { first: 'When to choose this', second: 'When to choose this' } }),
	noul: () => ({ type: 'noul', instructions: 'A statement the model rates from 0 (false) to 1 (true)' }),
	score: () => ({ type: 'score', instructions: 'What to rate', criteria: ['Lowest', 'Highest'] }),
};

export function addQuestion(workspace: Workspace, id: string, type: QuestionType): EditResult {
	const missing = requireQuestions(workspace);
	if (missing) return missing;
	if (!ID.test(id) || id === '$schema') return { ok: false, error: 'A question id cannot be empty or contain spaces.' };
	if (id in workspace.questions!) return { ok: false, error: `Question ${id} exists.` };
	return editDocuments(workspace, (docs) => {
		docs.questions![id] = STARTERS[type]();
	});
}

export function renameQuestion(workspace: Workspace, from: string, to: string): EditResult {
	const missing = requireQuestions(workspace);
	if (missing) return missing;
	if (!ID.test(to) || to === '$schema') return { ok: false, error: 'A question id cannot be empty or contain spaces.' };
	if (to !== from && to in workspace.questions!) return { ok: false, error: `Question ${to} exists.` };
	const template = new RegExp(`\\{\\{(\\s*)answers\\.${escape(from)}\\.`, 'g');
	return editDocuments(workspace, (docs) => {
		question(docs, from);
		docs.questions = renameKey(docs.questions!, from, to);
		for (const node of predicates(docs.rules)) if (node.question === from) node.question = to;
		const actions = [docs.rules.default_action, ...(docs.rules.rules as JsonObject[]).map((rule) => rule.action)] as JsonObject[];
		for (const action of actions) {
			for (const field of ['target', 'reason']) {
				if (typeof action[field] === 'string') action[field] = (action[field] as string).replace(template, `{{$1answers.${to}.`);
			}
		}
		for (const part of caseParts(docs.cases)) {
			if (isPlainObject(part.answers) && from in part.answers) part.answers = renameKey(part.answers, from, to);
		}
	});
}

/** Deletes a question no rule reads, with its saved answers in the cases. */
export function deleteQuestion(workspace: Workspace, id: string): EditResult {
	const missing = requireQuestions(workspace);
	if (missing) return missing;
	const users = questionUsers(workspace, id);
	if (users.length > 0) return { ok: false, error: `${id} is read by ${users.join(', ')}. Change those rules first.` };
	if (Object.keys(questionMap(workspace) ?? {}).length === 1) return { ok: false, error: 'A questions file needs at least one question.' };
	return editDocuments(workspace, (docs) => {
		delete docs.questions![id];
		for (const part of caseParts(docs.cases)) {
			if (isPlainObject(part.answers)) {
				delete part.answers[id];
				if (Object.keys(part.answers).length === 0) delete part.answers;
			}
		}
	});
}

export function setInstructions(workspace: Workspace, id: string, text: string): EditResult {
	return editDocuments(workspace, (docs) => {
		question(docs, id).instructions = text;
	});
}

/**
 * Changes a question's type, keeping what carries over: choice labels become
 * score levels and back. A rule that no longer fits shows as a lint error.
 */
export function setQuestionType(workspace: Workspace, id: string, type: QuestionType): EditResult {
	return editDocuments(workspace, (docs) => {
		const entry = question(docs, id);
		const labels = labelsOf(entry);
		entry.type = type;
		if (type === 'noul') delete entry.criteria;
		else if (type === 'score') entry.criteria = labels.length >= 2 ? labels : (STARTERS.score().criteria as string[]);
		else entry.criteria = labels.length >= 1 ? Object.fromEntries(labels.map((label) => [label, null])) : STARTERS.choice().criteria;
	});
}

// --- Choice labels and score levels -----------------------------------------

export function addLabel(workspace: Workspace, id: string, label: string): EditResult {
	if (label.trim() === '') return { ok: false, error: 'A label cannot be empty.' };
	return editDocuments(workspace, (docs) => {
		const entry = question(docs, id);
		if (labelsOf(entry).includes(label)) throw new Error(`${id} already has the label ${label}.`);
		if (Array.isArray(entry.criteria)) (entry.criteria as string[]).push(label);
		else entry.criteria = { ...(entry.criteria as JsonObject), [label]: null };
	});
}

export function setLabelDescription(workspace: Workspace, id: string, label: string, description: string): EditResult {
	return editDocuments(workspace, (docs) => {
		const entry = question(docs, id);
		// A list of labels has no descriptions, so the first one turns it into a map.
		const map = isPlainObject(entry.criteria) ? entry.criteria : Object.fromEntries(labelsOf(entry).map((name) => [name, null]));
		map[label] = description.trim() === '' ? null : description;
		entry.criteria = map;
	});
}

/** Renames a label in the question, every rule comparison on it, and every saved choice. */
export function renameLabel(workspace: Workspace, id: string, from: string, to: string): EditResult {
	if (to.trim() === '') return { ok: false, error: 'A label cannot be empty.' };
	return editDocuments(workspace, (docs) => {
		const entry = question(docs, id);
		if (to !== from && labelsOf(entry).includes(to)) throw new Error(`${id} already has the label ${to}.`);
		if (Array.isArray(entry.criteria)) entry.criteria = (entry.criteria as string[]).map((label) => (label === from ? to : label));
		else entry.criteria = renameKey(entry.criteria as JsonObject, from, to);
		for (const node of predicates(docs.rules)) {
			if (node.question !== id) continue;
			for (const key of IDENTITY_KEYS) {
				if (node[key] === from) node[key] = to;
				if (Array.isArray(node[key])) node[key] = (node[key] as unknown[]).map((value) => (value === from ? to : value));
			}
		}
		for (const answers of answerMaps(docs.cases)) {
			const answer = answers[id];
			if (!isPlainObject(answer)) continue;
			for (const field of ['choice', 'value', 'selected', 'label']) if (answer[field] === from) answer[field] = to;
			if (isPlainObject(answer.probabilities) && from in answer.probabilities) answer.probabilities = renameKey(answer.probabilities, from, to);
		}
	});
}

export function deleteLabel(workspace: Workspace, id: string, label: string): EditResult {
	const users = labelUsers(workspace, id, label);
	if (users.length > 0) return { ok: false, error: `${id} = ${label} is compared by ${users.join(', ')}. Change those rules first.` };
	return editDocuments(workspace, (docs) => {
		const entry = question(docs, id);
		if (Array.isArray(entry.criteria)) entry.criteria = (entry.criteria as string[]).filter((name) => name !== label);
		else {
			const map = { ...(entry.criteria as JsonObject) };
			delete map[label];
			entry.criteria = map;
		}
	});
}

export function addLevel(workspace: Workspace, id: string, text: string): EditResult {
	return editDocuments(workspace, (docs) => {
		(question(docs, id).criteria as string[]).push(text);
	});
}

export function setLevel(workspace: Workspace, id: string, index: number, text: string): EditResult {
	return editDocuments(workspace, (docs) => {
		(question(docs, id).criteria as string[])[index] = text;
	});
}

/** Removing or moving a level changes what each score number means, so rules on it need a look. */
export function deleteLevel(workspace: Workspace, id: string, index: number): EditResult {
	return editDocuments(workspace, (docs) => {
		(question(docs, id).criteria as string[]).splice(index, 1);
	});
}

export function moveLevel(workspace: Workspace, id: string, index: number, direction: -1 | 1): EditResult {
	return editDocuments(workspace, (docs) => {
		const levels = question(docs, id).criteria as string[];
		const target = index + direction;
		if (target < 0 || target >= levels.length) throw new Error('The level is already at that end.');
		[levels[index], levels[target]] = [levels[target]!, levels[index]!];
	});
}

function escape(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
