import {
	diffRulesets,
	isPlainObject,
	lintRuleset,
	referencedThresholds,
	traceRules,
	validateRuleset,
	type AnswerView,
	type EvaluationTrace,
	type LintFinding,
	type LintQuestion,
	type PolicyChange,
	type Ruleset,
} from 'decision-matrix-rules';
import { readAnswers, readCases, runCases, type CaseRun, type PolicyCase } from 'decision-matrix-cli';
import { validateQuestions } from 'decision-matrix-systemone';

/**
 * Editor state and every edit the TUI can make, with no rendering.
 *
 * The rules and cases are kept as the JSON documents the user wrote, so a
 * save keeps threshold names, descriptions, and the cases file's defaults.
 * Every edit is checked before it applies: the rules document is always a
 * valid ruleset, so lint, cases, and the diff can always be computed.
 */

export type JsonObject = Record<string, unknown>;

export interface Workspace {
	rulesPath: string;
	casesPath?: string;
	/** The rules as loaded, for the diff shown before saving. */
	savedRules: JsonObject;
	rules: JsonObject;
	savedCases?: JsonObject;
	cases?: JsonObject;
	questionsPath?: string;
	savedQuestions?: JsonObject;
	/** The questions document as written. It may hold `$schema`. Use questionMap to read questions. */
	questions?: JsonObject;
}

export interface Derived {
	ruleset: Ruleset;
	findings: LintFinding[];
	cases: PolicyCase[];
	run?: CaseRun;
	/** Set when the cases file cannot be read, for example after a bad edit by hand. */
	casesError?: string;
	changes: PolicyChange[];
}

export type EditResult = { ok: true; workspace: Workspace } | { ok: false; error: string };

/** An empty cases file, for a --cases path that does not exist yet. */
export const NEW_CASES = { version: 1, cases: [] };

export function createWorkspace(input: {
	rulesPath: string;
	rules: unknown;
	casesPath?: string;
	cases?: unknown;
	questionsPath?: string;
	/** An empty object starts a new questions file. */
	questions?: unknown;
}): Workspace {
	validateRuleset(input.rules);
	if (!isPlainObject(input.rules)) throw new Error('Rules must be a JSON object.');
	if (input.cases !== undefined) readCases(input.cases, input.casesPath);
	if (input.questions !== undefined) {
		if (!isPlainObject(input.questions)) throw new Error('Questions must be a JSON object keyed by question id.');
		if (Object.keys(questionEntries(input.questions)).length > 0) validateQuestions(input.questions);
	}
	const rules = clone(input.rules);
	const cases = input.cases === undefined ? undefined : (clone(input.cases) as JsonObject);
	const questions = input.questions === undefined ? undefined : (clone(input.questions) as JsonObject);
	return {
		rulesPath: input.rulesPath,
		...(input.casesPath ? { casesPath: input.casesPath } : {}),
		savedRules: clone(rules),
		rules,
		...(cases ? { savedCases: clone(cases), cases } : {}),
		...(input.questionsPath ? { questionsPath: input.questionsPath } : {}),
		...(questions ? { savedQuestions: clone(questions), questions } : {}),
	};
}

/** The questions, without `$schema`. Undefined when no questions file is open. */
export function questionMap(workspace: Workspace): Record<string, LintQuestion> | undefined {
	return workspace.questions ? (questionEntries(workspace.questions) as Record<string, LintQuestion>) : undefined;
}

function questionEntries(doc: JsonObject): JsonObject {
	const { $schema: _schema, ...questions } = doc;
	return questions;
}

export function derive(workspace: Workspace): Derived {
	const ruleset = validateRuleset(workspace.rules);
	const questions = questionMap(workspace);
	const findings = lintRuleset(workspace.rules, questions ? { questions } : {});
	const changes = diffRulesets(workspace.savedRules, workspace.rules);
	if (!workspace.cases) return { ruleset, findings, cases: [], changes };
	try {
		const cases = readCases(workspace.cases, workspace.casesPath);
		return { ruleset, findings, cases, run: runCases(workspace.rules, cases), changes };
	} catch (error) {
		return { ruleset, findings, cases: [], changes, casesError: message(error) };
	}
}

export interface Dirty {
	rules: boolean;
	cases: boolean;
	questions: boolean;
	any: boolean;
}

export function isDirty(workspace: Workspace): Dirty {
	const rules = JSON.stringify(workspace.rules) !== JSON.stringify(workspace.savedRules);
	const cases = JSON.stringify(workspace.cases) !== JSON.stringify(workspace.savedCases);
	const questions = JSON.stringify(workspace.questions) !== JSON.stringify(workspace.savedQuestions);
	return { rules, cases, questions, any: rules || cases || questions };
}

export function markSaved(workspace: Workspace): Workspace {
	return {
		...workspace,
		savedRules: clone(workspace.rules),
		...(workspace.cases ? { savedCases: clone(workspace.cases) } : {}),
		...(workspace.questions ? { savedQuestions: clone(workspace.questions) } : {}),
	};
}

/** The files a save writes: only the ones that changed. */
export function filesToSave(workspace: Workspace): Array<{ path: string; text: string }> {
	const dirty = isDirty(workspace);
	const files: Array<{ path: string; text: string }> = [];
	if (dirty.rules) files.push({ path: workspace.rulesPath, text: serialize(workspace.rules) });
	if (dirty.cases && workspace.casesPath && workspace.cases) files.push({ path: workspace.casesPath, text: serialize(workspace.cases) });
	if (dirty.questions && workspace.questionsPath && workspace.questions) {
		files.push({ path: workspace.questionsPath, text: serialize(workspace.questions) });
	}
	return files;
}

/**
 * Applies changes to any of the three documents and keeps them only if every
 * changed document still reads: a valid ruleset, a valid cases file, and a
 * valid questions file (an empty one is allowed while a new file is started).
 */
export function editDocuments(
	workspace: Workspace,
	change: (docs: { rules: JsonObject; cases?: JsonObject; questions?: JsonObject }) => void,
): EditResult {
	const docs = {
		rules: clone(workspace.rules),
		...(workspace.cases ? { cases: clone(workspace.cases) } : {}),
		...(workspace.questions ? { questions: clone(workspace.questions) } : {}),
	};
	try {
		change(docs);
		validateRuleset(docs.rules);
		if (docs.cases) readCases(docs.cases, workspace.casesPath);
		if (docs.questions && Object.keys(questionEntries(docs.questions)).length > 0) validateQuestions(docs.questions);
	} catch (error) {
		return { ok: false, error: message(error) };
	}
	return { ok: true, workspace: { ...workspace, ...docs } };
}

/** The trace for one case: which rule matched, and what every predicate saw. */
export function traceCase(workspace: Workspace, testCase: PolicyCase): EvaluationTrace | undefined {
	try {
		return traceRules(workspace.rules, testCase.answers ?? {}, testCase.thresholds, testCase.facts);
	} catch {
		return undefined;
	}
}

// --- Rules ------------------------------------------------------------------

function rulesList(workspace: Workspace): JsonObject[] {
	return workspace.rules.rules as JsonObject[];
}

/** Applies a change to a copy of the rules and keeps it only if the result validates. */
function editRules(workspace: Workspace, change: (rules: JsonObject) => void): EditResult {
	const rules = clone(workspace.rules);
	change(rules);
	try {
		validateRuleset(rules);
	} catch (error) {
		return { ok: false, error: message(error) };
	}
	return { ok: true, workspace: { ...workspace, rules } };
}

export function moveRule(workspace: Workspace, index: number, delta: -1 | 1): EditResult {
	const target = index + delta;
	if (target < 0 || target >= rulesList(workspace).length) return { ok: false, error: 'The rule is already at that end.' };
	return editRules(workspace, (rules) => {
		const list = rules.rules as JsonObject[];
		const [rule] = list.splice(index, 1);
		list.splice(target, 0, rule!);
	});
}

export function toggleGate(workspace: Workspace, index: number): EditResult {
	return editRules(workspace, (rules) => {
		const action = (rules.rules as JsonObject[])[index]!.action as JsonObject;
		action.gate = action.gate !== true;
	});
}

export function deleteRule(workspace: Workspace, index: number): EditResult {
	return editRules(workspace, (rules) => {
		(rules.rules as JsonObject[]).splice(index, 1);
	});
}

/** Replaces one rule with an edited copy, for example from $EDITOR. */
export function replaceRule(workspace: Workspace, index: number, rule: unknown): EditResult {
	if (!isPlainObject(rule)) return { ok: false, error: 'The edited rule must be a JSON object.' };
	return editRules(workspace, (rules) => {
		(rules.rules as JsonObject[])[index] = rule;
	});
}

/** A new rule after `index` that holds, so adding one can never open the gate by itself. */
export function insertRule(workspace: Workspace, index: number): EditResult {
	const ids = new Set(rulesList(workspace).map((rule) => String(rule.id)));
	let n = 1;
	while (ids.has(`new-rule-${n}`)) n++;
	const rule = {
		id: `new-rule-${n}`,
		description: 'Describe when this rule applies',
		when: { all: [{ fact: 'replace_me', eq: true }] },
		action: { type: 'hold', target: 'human', reason: 'Explain the decision', gate: true },
	};
	return editRules(workspace, (rules) => {
		(rules.rules as JsonObject[]).splice(index + 1, 0, rule);
	});
}

/** Replaces the default action, the one that applies when no rule matches. */
export function setDefaultAction(workspace: Workspace, action: unknown): EditResult {
	if (!isPlainObject(action)) return { ok: false, error: 'The default action must be an object.' };
	return editRules(workspace, (rules) => {
		rules.default_action = action;
	});
}

export function toggleDefaultGate(workspace: Workspace): EditResult {
	return editRules(workspace, (rules) => {
		const action = rules.default_action as JsonObject;
		action.gate = action.gate !== true;
	});
}

export function isStrict(workspace: Workspace): boolean {
	return workspace.rules.open_gate_requires_facts === true;
}

/** Turns open_gate_requires_facts on or off. Turning it on fails, with the reason, if a rule breaks it. */
export function setStrict(workspace: Workspace, on: boolean): EditResult {
	return editRules(workspace, (rules) => {
		if (on) rules.open_gate_requires_facts = true;
		else delete rules.open_gate_requires_facts;
	});
}

// --- Thresholds -------------------------------------------------------------

const THRESHOLD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const NUMERIC_KEYS = new Set(['gte', 'gt', 'lte', 'lt', 'confidence_gte', 'confidence_lt']);

function checkThresholdName(name: string): string | undefined {
	if (!THRESHOLD_NAME.test(name) || RESERVED.has(name)) {
		return `"${name}" cannot be a threshold name. Start with a letter or underscore, then use letters, digits, and underscores.`;
	}
	return undefined;
}

export function setThreshold(workspace: Workspace, name: string, value: number): EditResult {
	if (!Number.isFinite(value)) return { ok: false, error: `${name} must be a finite number.` };
	return editRules(workspace, (rules) => {
		rules.thresholds = { ...(rules.thresholds as JsonObject | undefined), [name]: round(value) };
	});
}

export function addThreshold(workspace: Workspace, name: string, value: number): EditResult {
	const bad = checkThresholdName(name);
	if (bad) return { ok: false, error: bad };
	if (name in ((workspace.rules.thresholds as JsonObject | undefined) ?? {})) return { ok: false, error: `Threshold ${name} exists.` };
	return setThreshold(workspace, name, value);
}

/** The rules (and "default") whose conditions or text use the threshold. */
export function thresholdUsers(workspace: Workspace, name: string): string[] {
	const ruleset = validateRuleset(workspace.rules);
	const users: string[] = [];
	const hold = { type: 'hold', target: 'x', reason: 'x', gate: true };
	for (const rule of ruleset.rules) {
		if (referencedThresholds({ ...ruleset, default_action: hold, rules: [rule] }).has(name)) users.push(rule.id);
	}
	if (referencedThresholds({ ...ruleset, rules: [] }).has(name)) users.push('default');
	return users;
}

/**
 * Renames a threshold everywhere: the thresholds block, every condition that
 * names it (as "name", {{thresholds.name}}, or {"threshold": "name"}), every
 * {{thresholds.name}} in a target or reason, and every case override.
 */
export function renameThreshold(workspace: Workspace, from: string, to: string): EditResult {
	const bad = checkThresholdName(to);
	if (bad) return { ok: false, error: bad };
	const thresholds = (workspace.rules.thresholds as JsonObject | undefined) ?? {};
	if (!(from in thresholds)) return { ok: false, error: `There is no threshold ${from}.` };
	if (to !== from && to in thresholds) return { ok: false, error: `Threshold ${to} exists.` };
	const template = new RegExp(`\\{\\{\\s*thresholds\\.${from}\\s*\\}\\}`, 'g');
	return editDocuments(workspace, (docs) => {
		docs.rules.thresholds = renameKey(thresholds, from, to);
		const renameOperand = (value: unknown): unknown => {
			if (value === from) return to;
			if (typeof value === 'string') return value.replace(template, `{{thresholds.${to}}}`);
			if (isPlainObject(value) && value.threshold === from) return { ...value, threshold: to };
			return value;
		};
		const walk = (node: unknown): void => {
			if (Array.isArray(node)) return node.forEach(walk);
			if (!isPlainObject(node)) return;
			for (const [key, value] of Object.entries(node)) {
				if (NUMERIC_KEYS.has(key)) node[key] = renameOperand(value);
				else walk(value);
			}
		};
		const actions = [docs.rules.default_action, ...(docs.rules.rules as JsonObject[]).map((rule) => rule.action)] as JsonObject[];
		for (const action of actions) {
			for (const field of ['target', 'reason']) {
				if (typeof action[field] === 'string') action[field] = (action[field] as string).replace(template, `{{thresholds.${to}}}`);
			}
		}
		for (const rule of docs.rules.rules as JsonObject[]) walk(rule.when);
		for (const part of caseParts(docs.cases)) {
			if (isPlainObject(part.thresholds) && from in part.thresholds) part.thresholds = renameKey(part.thresholds, from, to);
		}
	});
}

/** Deletes an unused threshold, and any case overrides of it. */
export function deleteThreshold(workspace: Workspace, name: string): EditResult {
	const users = thresholdUsers(workspace, name);
	if (users.length > 0) return { ok: false, error: `${name} is used by ${users.join(', ')}. Change those first.` };
	return editDocuments(workspace, (docs) => {
		const thresholds = { ...(docs.rules.thresholds as JsonObject) };
		delete thresholds[name];
		docs.rules.thresholds = thresholds;
		for (const part of caseParts(docs.cases)) {
			if (isPlainObject(part.thresholds)) {
				delete part.thresholds[name];
				if (Object.keys(part.thresholds).length === 0) delete part.thresholds;
			}
		}
	});
}

/** A step that suits the value: hundredths for probabilities, whole numbers otherwise. */
export function thresholdStep(value: number): number {
	return Math.abs(value) <= 1 ? 0.05 : 1;
}

// --- Cases ------------------------------------------------------------------

/** Which part of the cases file an edit applies to: the shared defaults, or one case. */
export type CaseScope = { kind: 'defaults' } | { kind: 'case'; index: number };

/** One editable value in a case or the defaults: a fact leaf or an answer's value. */
export interface CaseValue {
	kind: 'fact' | 'answer';
	/** Dotted fact path, or the question id. */
	path: string;
	value: unknown;
	/** For an answer: its type. */
	answerType?: AnswerView['type'];
	/** True when this scope sets the value itself rather than inheriting it from defaults. */
	own: boolean;
}

function caseList(workspace: Workspace): JsonObject[] {
	return (workspace.cases?.cases as JsonObject[] | undefined) ?? [];
}

/** The defaults and every case, the places that can hold facts, answers, and thresholds. */
function caseParts(cases: JsonObject | undefined): JsonObject[] {
	if (!cases) return [];
	const parts = (cases.cases as JsonObject[]).slice();
	if (isPlainObject(cases.defaults)) parts.unshift(cases.defaults);
	return parts;
}

function rawScope(cases: JsonObject, scope: CaseScope, create: boolean): JsonObject | undefined {
	if (scope.kind === 'case') return (cases.cases as JsonObject[])[scope.index];
	if (!isPlainObject(cases.defaults)) {
		if (!create) return undefined;
		cases.defaults = {};
	}
	return cases.defaults as JsonObject;
}

function scopeAnswers(workspace: Workspace, derived: Derived, scope: CaseScope): Record<string, AnswerView> {
	if (scope.kind === 'case') return derived.cases[scope.index]?.answers ?? {};
	const defaults = isPlainObject(workspace.cases?.defaults) ? workspace.cases.defaults : {};
	return isPlainObject(defaults.answers) ? readAnswers(defaults.answers) : {};
}

/** Answers first, then facts, each marked with whether this scope sets it. */
export function scopeValues(workspace: Workspace, derived: Derived, scope: CaseScope): CaseValue[] {
	const raw = (workspace.cases && rawScope(workspace.cases, scope, false)) ?? {};
	const facts = scope.kind === 'case' ? (derived.cases[scope.index]?.facts ?? {}) : isPlainObject(raw.facts) ? raw.facts : {};
	const ownAnswers = isPlainObject(raw.answers) ? raw.answers : {};
	const values: CaseValue[] = [];
	for (const [question, answer] of Object.entries(scopeAnswers(workspace, derived, scope))) {
		const value = answer.type === 'choice' ? answer.choice : answer.type === 'noul' ? answer.noul : answer.score;
		values.push({ kind: 'answer', path: question, value, answerType: answer.type, own: question in ownAnswers });
	}
	const walk = (value: unknown, path: string[], own: unknown) => {
		if (isPlainObject(value)) {
			for (const [key, child] of Object.entries(value)) walk(child, [...path, key], isPlainObject(own) ? own[key] : undefined);
			return;
		}
		values.push({ kind: 'fact', path: path.join('.'), value, own: own !== undefined });
	};
	walk(facts, [], raw.facts);
	return values;
}

function editCases(workspace: Workspace, change: (cases: JsonObject) => void): EditResult {
	if (!workspace.cases) return { ok: false, error: 'No cases file is open. Start with --cases <file>.' };
	return editDocuments(workspace, (docs) => change(docs.cases!));
}

function setPath(root: JsonObject, segments: string[], value: unknown): void {
	let node = root;
	for (const segment of segments.slice(0, -1)) {
		if (!isPlainObject(node[segment])) node[segment] = {};
		node = node[segment] as JsonObject;
	}
	node[segments[segments.length - 1]!] = value;
}

/** Sets one value on the scope. A case gets an override, and the defaults stay as they are. */
export function setScopeValue(workspace: Workspace, derived: Derived, scope: CaseScope, value: CaseValue, next: unknown): EditResult {
	const current = scopeAnswers(workspace, derived, scope)[value.path];
	return editCases(workspace, (cases) => {
		const raw = rawScope(cases, scope, true)!;
		if (value.kind === 'fact') {
			if (!isPlainObject(raw.facts)) raw.facts = {};
			setPath(raw.facts as JsonObject, value.path.split('.'), next);
		} else {
			if (!isPlainObject(raw.answers)) raw.answers = {};
			const field = value.answerType === 'choice' ? 'choice' : value.answerType === 'noul' ? 'noul' : 'score';
			(raw.answers as JsonObject)[value.path] = { ...current, [field]: next };
		}
	});
}

/** Adds a fact at a dotted path, for example grant.privileged. */
export function addScopeFact(workspace: Workspace, scope: CaseScope, path: string, value: unknown): EditResult {
	const segments = path.trim().split('.');
	if (segments.some((segment) => segment === '')) return { ok: false, error: `"${path}" is not a fact path.` };
	return editCases(workspace, (cases) => {
		const raw = rawScope(cases, scope, true)!;
		if (!isPlainObject(raw.facts)) raw.facts = {};
		setPath(raw.facts as JsonObject, segments, value);
	});
}

/** Adds an answer for a question, starting from a value that fits its type. */
export function addScopeAnswer(workspace: Workspace, scope: CaseScope, question: string): EditResult {
	const definition = questionMap(workspace)?.[question];
	const type = definition?.type;
	const labels = isPlainObject(definition?.criteria) ? Object.keys(definition.criteria) : Array.isArray(definition?.criteria) ? (definition.criteria as string[]) : [];
	const answer =
		type === 'choice' ? { type, choice: labels[0] ?? 'label' } : type === 'score' ? { type, score: 0 } : { type: 'noul', noul: 0.5 };
	return editCases(workspace, (cases) => {
		const raw = rawScope(cases, scope, true)!;
		if (!isPlainObject(raw.answers)) raw.answers = {};
		(raw.answers as JsonObject)[question] = answer;
	});
}

/** Removes what this scope sets. In a case, the default value applies again. */
export function removeScopeValue(workspace: Workspace, scope: CaseScope, value: CaseValue): EditResult {
	if (!value.own) {
		return { ok: false, error: 'This value comes from the defaults. Select the defaults row to change or remove it.' };
	}
	return editCases(workspace, (cases) => {
		const raw = rawScope(cases, scope, false)!;
		if (value.kind === 'answer') {
			delete (raw.answers as JsonObject)[value.path];
			if (Object.keys(raw.answers as JsonObject).length === 0) delete raw.answers;
			return;
		}
		const segments = value.path.split('.');
		const stack: JsonObject[] = [raw.facts as JsonObject];
		for (const segment of segments.slice(0, -1)) stack.push(stack[stack.length - 1]![segment] as JsonObject);
		delete stack[stack.length - 1]![segments[segments.length - 1]!];
		// Drop objects the removal left empty, innermost first.
		for (let i = stack.length - 1; i > 0; i--) {
			if (Object.keys(stack[i]!).length === 0) delete stack[i - 1]![segments[i - 1]!];
		}
		if (Object.keys(raw.facts as JsonObject).length === 0) delete raw.facts;
	});
}

/** The next value for a left/right or space press, or undefined when the key does not apply. */
export function stepCaseValue(value: CaseValue, direction: -1 | 1, workspace: Workspace): unknown {
	const current = value.value;
	if (typeof current === 'boolean') return !current;
	if (value.answerType === 'choice') {
		const criteria = questionMap(workspace)?.[value.path]?.criteria;
		const labels = isPlainObject(criteria) ? Object.keys(criteria) : Array.isArray(criteria) ? (criteria as string[]) : [];
		if (labels.length === 0) return undefined;
		const at = labels.indexOf(String(current));
		return labels[(at + direction + labels.length) % labels.length];
	}
	if (typeof current !== 'number') return undefined;
	if (value.answerType === 'noul') return round(Math.min(1, Math.max(0, current + direction * 0.05)));
	return round(current + direction);
}

export const EXPECT_FIELDS = ['matched_rule', 'action', 'target', 'reason', 'gate', 'from_facts', 'error'] as const;
export type ExpectField = (typeof EXPECT_FIELDS)[number];

/** Sets one expectation, or removes it when `value` is undefined. A case keeps at least one. */
export function setExpectation(workspace: Workspace, index: number, field: ExpectField, value: unknown): EditResult {
	return editCases(workspace, (cases) => {
		const raw = (cases.cases as JsonObject[])[index]!;
		const expect = { ...(raw.expect as JsonObject) };
		if (value === undefined) delete expect[field];
		else expect[field] = value;
		if (Object.keys(expect).length === 0) throw new Error('A case needs at least one expectation.');
		raw.expect = expect;
	});
}

/** Makes the case expect what the rules decide now, like accepting a snapshot. */
export function acceptDecision(workspace: Workspace, index: number, derived: Derived): EditResult {
	const result = derived.run?.results[index];
	if (!result?.decision) return { ok: false, error: 'This case has no decision to accept. It raised an error.' };
	const { matched_rule, action, gate } = result.decision;
	return editCases(workspace, (cases) => {
		(cases.cases as JsonObject[])[index]!.expect = { matched_rule, action, gate };
	});
}

function checkCaseName(workspace: Workspace, name: string, except?: number): string | undefined {
	if (name.trim() === '') return 'A case needs a name.';
	if (caseList(workspace).some((entry, i) => i !== except && entry.name === name.trim())) return `A case named "${name.trim()}" exists.`;
	return undefined;
}

export function renameCase(workspace: Workspace, index: number, name: string): EditResult {
	const bad = checkCaseName(workspace, name, index);
	if (bad) return { ok: false, error: bad };
	return editCases(workspace, (cases) => {
		(cases.cases as JsonObject[])[index]!.name = name.trim();
	});
}

/** A copy of a case under a new name, expecting what the rules decide for it now. */
export function addCaseFrom(workspace: Workspace, index: number, name: string, derived: Derived): EditResult {
	const bad = checkCaseName(workspace, name);
	if (bad) return { ok: false, error: bad };
	const source = caseList(workspace)[index];
	const decision = derived.run?.results[index]?.decision;
	if (!source || !decision) return { ok: false, error: 'Select a case with a decision to copy.' };
	return editCases(workspace, (cases) => {
		const copy = clone(source);
		copy.name = name.trim();
		copy.expect = { matched_rule: decision.matched_rule, action: decision.action, gate: decision.gate };
		(cases.cases as JsonObject[]).splice(index + 1, 0, copy);
	});
}

/** A new case with only the defaults, at `at`, expecting what the rules decide for it now. */
export function addBlankCase(workspace: Workspace, at: number, name: string): EditResult {
	const bad = checkCaseName(workspace, name);
	if (bad) return { ok: false, error: bad };
	const added = editCases(workspace, (cases) => {
		(cases.cases as JsonObject[]).splice(at, 0, { name: name.trim(), expect: { gate: true } });
	});
	if (!added.ok) return added;
	const run = derive(added.workspace).run;
	const decision = run?.results[at]?.decision;
	if (!decision) return added;
	return editCases(added.workspace, (cases) => {
		(cases.cases as JsonObject[])[at]!.expect = { matched_rule: decision.matched_rule, action: decision.action, gate: decision.gate };
	});
}

export function deleteCase(workspace: Workspace, index: number): EditResult {
	return editCases(workspace, (cases) => {
		(cases.cases as JsonObject[]).splice(index, 1);
	});
}

// --- Helpers ----------------------------------------------------------------

/** Two-space JSON with a final newline, the format of the shipped files. */
export function serialize(doc: unknown): string {
	return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Reads text typed into a prompt as a fact or threshold value: JSON when it parses, else a string. */
export function parseTyped(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/** A copy of the object with one key renamed in place, keeping the key order. */
export function renameKey(object: JsonObject, from: string, to: string): JsonObject {
	const renamed: JsonObject = {};
	for (const [key, value] of Object.entries(object)) renamed[key === from ? to : key] = value;
	return renamed;
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function round(value: number): number {
	return Math.round(value * 1e6) / 1e6;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
