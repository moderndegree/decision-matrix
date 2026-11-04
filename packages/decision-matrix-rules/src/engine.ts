import { describeValue, isPlainObject } from './object';
import { RulesError } from './errors';
import type {
	ActionSpec,
	AnswerView,
	Condition,
	EvaluationResult,
	FactOperator,
	FactValue,
	Operator,
	Rule,
	Ruleset,
	ThresholdRef,
} from './types';

/**
 * First-match rules engine for System One answers.
 *
 * Deterministic and free of I/O. The same ruleset, answers, and threshold
 * overrides always produce the same result. Rules run in array order and the
 * first rule whose `when` tree is true wins. Every branch of `all` / `any`
 * is evaluated, so a later typo still surfaces even when an earlier branch
 * already decided the boolean result. If no rule matches, `default_action`
 * is returned with `matched_rule: null` and `confidence: 0`.
 *
 * Numeric operators (`gte`, `gt`, `lte`, `lt`, `confidence_gte`,
 * `confidence_lt`) accept a number, a threshold name, `{{thresholds.name}}`,
 * or `{ "threshold": "name" }`. Names resolve against `rules.thresholds`
 * after node-level overrides replace same-named entries. Choice operators
 * (`eq`, `neq`, `in`, `not_in`) compare option labels literally and never
 * look up thresholds.
 *
 * Several operators on one predicate are AND, checked in a fixed order
 * (identity, then confidence, then numeric) so JSON key order cannot change
 * the result. Identity operators and numeric operators cannot share a
 * predicate, because one question is either a choice or a noul/score.
 *
 * Fact predicates (`{ "fact": "path.to.value", ... }`) read values the host
 * verified itself, passed separately from the model answers. They compare
 * strictly and fail closed: a missing fact or a value of the wrong type is
 * an error, never a silent false. Facts are not sent to the decision server.
 */

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const THRESHOLD_TEMPLATE = /^\{\{\s*thresholds\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;
const RESERVED_NAMES = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_DEPTH = 32;

const IDENTITY_OPS = ['eq', 'neq', 'in', 'not_in'] as const;
const CONFIDENCE_OPS = ['confidence_gte', 'confidence_lt'] as const;
const NUMERIC_OPS = ['gte', 'gt', 'lte', 'lt'] as const;
const OPERATOR_NAMES = [...IDENTITY_OPS, ...CONFIDENCE_OPS, ...NUMERIC_OPS] as const;
const CONTAINS_OPS = ['contains', 'not_contains'] as const;
const FACT_OPERATOR_NAMES = [...IDENTITY_OPS, ...CONTAINS_OPS, ...NUMERIC_OPS] as const;
const FACT_SEGMENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export type ThresholdMap = Record<string, number>;
/** Host-verified values keyed by name. Nested objects are reached with dotted paths. */
export type FactMap = Record<string, unknown>;

const RULESET_KEYS = new Set(['version', 'default_action', 'thresholds', 'rules', 'open_gate_requires_facts']);
const RULE_KEYS = new Set(['id', 'description', 'when', 'action']);
const ACTION_KEYS = new Set(['type', 'target', 'reason', 'gate']);

export function validateRuleset(input: unknown): Ruleset {
	if (!isPlainObject(input)) {
		throw new RulesError(
			`Rules must be a JSON object with "version", "default_action", and "rules". Received ${describeValue(input)}.`,
		);
	}
	assertKnownKeys(input, RULESET_KEYS, 'rules');

	if (input.version !== 1) {
		throw new RulesError(
			`rules.version must be the number 1. Received ${JSON.stringify(input.version)}.`,
		);
	}

	const thresholds = readThresholdBlock(input.thresholds, 'rules.thresholds');
	const defaultAction = readAction(input.default_action, 'rules.default_action');

	if (!Array.isArray(input.rules)) {
		throw new RulesError(`rules.rules must be an array. Received ${describeValue(input.rules)}.`);
	}

	const seenIds = new Set<string>();
	const rules = input.rules.map((rule, index) => readRule(rule, `rules[${index}]`, seenIds));

	if (input.open_gate_requires_facts !== undefined && typeof input.open_gate_requires_facts !== 'boolean') {
		throw new RulesError('rules.open_gate_requires_facts must be a boolean.');
	}
	const strict = input.open_gate_requires_facts === true;
	if (strict) assertModelCannotOpenGate(defaultAction, rules);

	return {
		version: 1,
		default_action: defaultAction,
		thresholds,
		rules,
		...(strict ? { open_gate_requires_facts: true } : {}),
	};
}

/**
 * `open_gate_requires_facts`: the default holds, and a rule with gate false
 * must require a fact on every path through `when`. A fact under `any` next to
 * a question-only branch does not count, because that branch can match alone.
 */
function assertModelCannotOpenGate(defaultAction: ActionSpec, rules: Rule[]): void {
	if (!defaultAction.gate) {
		throw new RulesError(
			'rules.open_gate_requires_facts is true, so rules.default_action.gate must be true. A ruleset that requires facts to open the gate must hold when no rule matches.',
		);
	}
	rules.forEach((rule, index) => {
		if (rule.action.gate) return;
		if (!requiresFact(rule.when)) {
			throw new RulesError(
				`rules[${index}] ("${rule.id}") opens the gate (gate false), but model answers alone can satisfy its "when". rules.open_gate_requires_facts is true, so put a fact predicate under "all" on every path, for example { "all": [{ "fact": "...", "eq": true }, ...] }.`,
			);
		}
	});
}

/** True when every way to satisfy the condition goes through a fact predicate. */
export function requiresFact(condition: Condition): boolean {
	if (condition.kind === 'fact') return true;
	if (condition.kind === 'predicate') return false;
	if (condition.kind === 'all') return condition.conditions.some(requiresFact);
	return condition.conditions.every(requiresFact);
}

/**
 * Validates the ruleset and checks that every threshold name it references
 * exists after overrides are applied. Call this before contacting the server.
 */
export function assertThresholdsResolve(
	rulesetInput: unknown,
	thresholdOverrides?: Record<string, number>,
): Ruleset {
	const ruleset = validateRuleset(rulesetInput);
	const thresholds = mergeThresholds(ruleset.thresholds, thresholdOverrides);
	for (const name of referencedThresholds(ruleset)) {
		if (!Object.prototype.hasOwnProperty.call(thresholds, name)) {
			const known = Object.keys(thresholds);
			const listed = known.length > 0 ? known.join(', ') : '(none)';
			throw new RulesError(
				`Threshold "${name}" is referenced by the ruleset. Add it under rules.thresholds or pass it as a threshold override. Defined thresholds: ${listed}.`,
			);
		}
	}
	return ruleset;
}

/**
 * Validates the ruleset and checks that every fact path it references exists
 * in `facts`. Call this before contacting the server so a missing fact does
 * not spend a request.
 */
export function assertFactsResolve(rulesetInput: unknown, facts?: FactMap): Ruleset {
	const ruleset = validateRuleset(rulesetInput);
	const factMap = readFactMap(facts);
	for (const rule of ruleset.rules) {
		for (const path of referencedFactPaths(rule.when)) {
			lookupFact(factMap, path, `rule "${rule.id}"`);
		}
	}
	return ruleset;
}

export function evaluateRules(
	rulesetInput: unknown,
	answers: Record<string, AnswerView>,
	thresholdOverrides?: Record<string, number>,
	facts?: FactMap,
): EvaluationResult {
	const ruleset = assertThresholdsResolve(rulesetInput, thresholdOverrides);
	assertAnswerMap(answers);
	const factMap = readFactMap(facts);
	const thresholds = mergeThresholds(ruleset.thresholds, thresholdOverrides);

	for (const rule of ruleset.rules) {
		// First true rule wins. Later rules are not consulted.
		if (evaluateCondition(rule.when, answers, factMap, thresholds, `rule "${rule.id}"`, 0)) {
			return materialize(rule.action, answers, factMap, thresholds, rule.id, confidenceFor(rule.when, answers));
		}
	}

	return materialize(ruleset.default_action, answers, factMap, thresholds, null, 0);
}

/**
 * Decides from facts alone when the first matching rule needs no model answer.
 *
 * Rules are tried in order while they reference only facts. The first one
 * that matches is the decision, exactly as `evaluateRules` would return it.
 * The scan stops at the first rule that references a question, because that
 * rule could match first once answers exist. Returns null when the server
 * must be asked. A host that gets a decision here skips the request, so the
 * untrusted text never reaches the model.
 */
export function decideFromFacts(
	rulesetInput: unknown,
	facts?: FactMap,
	thresholdOverrides?: Record<string, number>,
): EvaluationResult | null {
	const ruleset = assertThresholdsResolve(rulesetInput, thresholdOverrides);
	const factMap = readFactMap(facts);
	const thresholds = mergeThresholds(ruleset.thresholds, thresholdOverrides);
	const noAnswers: Record<string, AnswerView> = {};

	for (const rule of ruleset.rules) {
		if (referencedQuestions(rule.when).length > 0) return null;
		if (evaluateCondition(rule.when, noAnswers, factMap, thresholds, `rule "${rule.id}"`, 0)) {
			return materialize(rule.action, noAnswers, factMap, thresholds, rule.id, confidenceFor(rule.when, noAnswers));
		}
	}
	return null;
}

/** Question ids referenced anywhere in a condition tree, in first-seen order. */
export function referencedQuestions(condition: Condition): string[] {
	const found: string[] = [];
	const seen = new Set<string>();
	walk(condition);
	return found;

	function walk(current: Condition): void {
		if (current.kind === 'fact') return;
		if (current.kind === 'predicate') {
			if (!seen.has(current.question)) {
				seen.add(current.question);
				found.push(current.question);
			}
			return;
		}
		for (const child of current.conditions) walk(child);
	}
}

/** Fact paths referenced anywhere in a condition tree, as written, in first-seen order. */
export function referencedFacts(condition: Condition): string[] {
	return referencedFactPaths(condition).map((path) => path.join('.'));
}

function referencedFactPaths(condition: Condition): string[][] {
	const found: string[][] = [];
	const seen = new Set<string>();
	walk(condition);
	return found;

	function walk(current: Condition): void {
		if (current.kind === 'predicate') return;
		if (current.kind === 'fact') {
			if (!seen.has(current.fact)) {
				seen.add(current.fact);
				found.push(current.path);
			}
			return;
		}
		for (const child of current.conditions) walk(child);
	}
}

function readFactMap(facts: FactMap | undefined): FactMap {
	if (facts === undefined) return {};
	if (!isPlainObject(facts)) {
		throw new RulesError(`Facts must be a JSON object keyed by fact name. Received ${describeValue(facts)}.`);
	}
	return facts;
}

/** Own properties only, through plain objects. A missing segment is an error. */
function lookupFact(facts: FactMap, path: string[], ruleLabel: string): unknown {
	let current: unknown = facts;
	for (let index = 0; index < path.length; index++) {
		const segment = path[index];
		if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
			const dotted = path.join('.');
			const parent = index === 0 ? facts : current;
			const known = isPlainObject(parent) ? Object.keys(parent) : [];
			const listed = known.length > 0 ? known.join(', ') : '(none)';
			throw new RulesError(
				`${ruleLabel} references fact "${dotted}", which is missing. A missing fact is an error, not false. Set it to a value or null. Facts at that level: ${listed}.`,
			);
		}
		current = current[segment];
	}
	return current;
}

/**
 * Confidence used by `confidence_gte` / `confidence_lt` and by the output
 * `confidence` field.
 *
 * Choice and score prefer the server's `confidence`. When that field is
 * absent, choice uses the probability of the selected option, then the
 * maximum probability. Score uses the maximum level probability.
 * Noul answers have no separate confidence. Their contribution is
 * decisiveness, `abs(noul - 0.5) * 2`: 0.5 contributes 0 and 0 or 1
 * contributes 1. That is uncertainty, not the yes-probability itself.
 * Returns undefined when none of those signals exist.
 */
export function bestEffortConfidence(answer: AnswerView): number | undefined {
	if (typeof answer.confidence === 'number' && Number.isFinite(answer.confidence)) {
		return answer.confidence;
	}
	if (answer.type === 'noul' && typeof answer.noul === 'number' && Number.isFinite(answer.noul)) {
		return Math.abs(answer.noul - 0.5) * 2;
	}
	const probabilities = answer.probabilities;
	if (probabilities) {
		if (answer.type === 'choice' && answer.choice !== undefined) {
			const selected = probabilities[answer.choice];
			if (typeof selected === 'number' && Number.isFinite(selected)) return selected;
		}
		const values = Object.values(probabilities).filter(
			(value): value is number => typeof value === 'number' && Number.isFinite(value),
		);
		if (values.length > 0) return Math.max(...values);
	}
	return undefined;
}

function evaluateCondition(
	condition: Condition,
	answers: Record<string, AnswerView>,
	facts: FactMap,
	thresholds: ThresholdMap,
	ruleLabel: string,
	depth: number,
): boolean {
	if (depth > MAX_DEPTH) {
		throw new RulesError(`${ruleLabel} nests conditions more than ${MAX_DEPTH} levels deep.`);
	}
	if (condition.kind === 'all') {
		let matched = true;
		for (const child of condition.conditions) {
			if (!evaluateCondition(child, answers, facts, thresholds, ruleLabel, depth + 1)) matched = false;
		}
		return matched;
	}
	if (condition.kind === 'any') {
		let matched = false;
		for (const child of condition.conditions) {
			if (evaluateCondition(child, answers, facts, thresholds, ruleLabel, depth + 1)) matched = true;
		}
		return matched;
	}
	if (condition.kind === 'fact') {
		return evaluateFactPredicate(condition, facts, thresholds, ruleLabel);
	}
	return evaluatePredicate(condition.question, condition.operators, answers, thresholds, ruleLabel);
}

function evaluateFactPredicate(
	condition: Extract<Condition, { kind: 'fact' }>,
	facts: FactMap,
	thresholds: ThresholdMap,
	ruleLabel: string,
): boolean {
	const actual = lookupFact(facts, condition.path, ruleLabel);
	let matched = true;
	for (const operator of condition.operators) {
		if (!evaluateFactOperator(operator, actual, condition.fact, thresholds, ruleLabel)) matched = false;
	}
	return matched;
}

function evaluateFactOperator(
	operator: FactOperator,
	actual: unknown,
	fact: string,
	thresholds: ThresholdMap,
	ruleLabel: string,
): boolean {
	const label = `${ruleLabel} fact "${fact}" ${operator.op}`;
	if (operator.op === 'eq' || operator.op === 'neq') {
		const value = requireFactScalar(actual, label, [operator.value]);
		return operator.op === 'eq' ? value === operator.value : value !== operator.value;
	}
	if (operator.op === 'in' || operator.op === 'not_in') {
		const value = requireFactScalar(actual, label, operator.values);
		const found = operator.values.includes(value);
		return operator.op === 'in' ? found : !found;
	}
	if (operator.op === 'contains' || operator.op === 'not_contains') {
		if (!Array.isArray(actual) || !actual.every(isFactValue)) {
			throw new RulesError(`${label} needs an array of strings, numbers, booleans, or null. Received ${describeValue(actual)}.`);
		}
		const found = actual.includes(operator.value);
		return operator.op === 'contains' ? found : !found;
	}
	if (typeof actual !== 'number' || !Number.isFinite(actual)) {
		throw new RulesError(`${label} needs a finite number. Received ${describeValue(actual)}.`);
	}
	// Every other operator returned above.
	const numeric = operator as Extract<FactOperator, { op: 'gte' | 'gt' | 'lte' | 'lt' }>;
	const expected = resolveThreshold(numeric.value, thresholds, label);
	switch (numeric.op) {
		case 'gte':
			return actual >= expected;
		case 'gt':
			return actual > expected;
		case 'lte':
			return actual <= expected;
		case 'lt':
			return actual < expected;
		default:
			return assertNever(numeric.op);
	}
}

/**
 * A scalar fact whose type matches at least one operand, or null. A boolean
 * fact compared with "true" is a host bug, so it throws instead of returning
 * a quiet false that would skip a deny rule.
 */
function requireFactScalar(actual: unknown, label: string, operands: FactValue[]): FactValue {
	if (!isFactValue(actual)) {
		throw new RulesError(`${label} needs a string, number, boolean, or null. Received ${describeValue(actual)}.`);
	}
	if (actual === null) return actual;
	const typed = operands.filter((operand) => operand !== null);
	if (typed.length > 0 && !typed.some((operand) => typeof operand === typeof actual)) {
		throw new RulesError(
			`${label} compares a ${typeof actual} fact with ${typed.map((operand) => JSON.stringify(operand)).join(', ')}. Fact comparisons are strict, so fix the operand or the fact type.`,
		);
	}
	return actual;
}

function isFactValue(value: unknown): value is FactValue {
	return (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean' ||
		(typeof value === 'number' && Number.isFinite(value))
	);
}

function evaluatePredicate(
	question: string,
	operators: Operator[],
	answers: Record<string, AnswerView>,
	thresholds: ThresholdMap,
	ruleLabel: string,
): boolean {
	const answer = requireAnswer(answers, question, ruleLabel);
	let matched = true;
	for (const operator of operators) {
		if (!evaluateOperator(operator, answer, question, thresholds, ruleLabel)) matched = false;
	}
	return matched;
}

function requireAnswer(answers: Record<string, AnswerView>, question: string, ruleLabel: string): AnswerView {
	const answer = answers[question];
	if (!answer) {
		const returned = Object.keys(answers);
		const listed = returned.length > 0 ? returned.join(', ') : '(none)';
		throw new RulesError(
			`${ruleLabel} references question "${question}", which is absent from the decision server answers. Returned questions: ${listed}.`,
		);
	}
	return answer;
}

/** One operator check in a trace. `threshold` names the threshold the expected number came from. */
export interface TraceCheck {
	op: string;
	expected: unknown;
	threshold?: string;
	matched: boolean;
}

export type TraceNode =
	| { kind: 'all'; matched: boolean; children: TraceNode[] }
	| { kind: 'any'; matched: boolean; children: TraceNode[] }
	| { kind: 'question'; question: string; value: unknown; confidence?: number; matched: boolean; checks: TraceCheck[] }
	| { kind: 'fact'; fact: string; value: unknown; matched: boolean; checks: TraceCheck[] };

export interface RuleTrace {
	id: string;
	matched: boolean;
	/** Set when this rule could not be evaluated, for example a missing answer or fact. */
	error?: string;
	when?: TraceNode;
}

export interface EvaluationTrace {
	rules: RuleTrace[];
	/** What evaluateRules returns. Absent when evaluation throws, with the message in `error`. */
	decision?: EvaluationResult;
	error?: string;
}

/**
 * Explains an evaluation. Every rule is traced, including rules after the
 * winner, with the value each predicate saw and the result of each operator.
 * Uses the same operator code as evaluateRules, so the two cannot disagree.
 * A ruleset that does not validate still throws.
 */
export function traceRules(
	rulesetInput: unknown,
	answers: Record<string, AnswerView>,
	thresholdOverrides?: Record<string, number>,
	facts?: FactMap,
): EvaluationTrace {
	const ruleset = assertThresholdsResolve(rulesetInput, thresholdOverrides);
	assertAnswerMap(answers);
	const factMap = readFactMap(facts);
	const thresholds = mergeThresholds(ruleset.thresholds, thresholdOverrides);

	const rules = ruleset.rules.map((rule): RuleTrace => {
		try {
			const when = traceCondition(rule.when, answers, factMap, thresholds, `rule "${rule.id}"`);
			return { id: rule.id, matched: when.matched, when };
		} catch (error) {
			return { id: rule.id, matched: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	try {
		return { rules, decision: evaluateRules(rulesetInput, answers, thresholdOverrides, facts) };
	} catch (error) {
		return { rules, error: error instanceof Error ? error.message : String(error) };
	}
}

function traceCondition(
	condition: Condition,
	answers: Record<string, AnswerView>,
	facts: FactMap,
	thresholds: ThresholdMap,
	ruleLabel: string,
): TraceNode {
	if (condition.kind === 'all' || condition.kind === 'any') {
		const children = condition.conditions.map((child) => traceCondition(child, answers, facts, thresholds, ruleLabel));
		return condition.kind === 'all'
			? { kind: 'all', matched: children.every((child) => child.matched), children }
			: { kind: 'any', matched: children.some((child) => child.matched), children };
	}
	if (condition.kind === 'fact') {
		const value = lookupFact(facts, condition.path, ruleLabel);
		const checks = condition.operators.map((operator) => ({
			...describeOperand(operator, thresholds),
			matched: evaluateFactOperator(operator, value, condition.fact, thresholds, ruleLabel),
		}));
		return { kind: 'fact', fact: condition.fact, value, matched: checks.every((check) => check.matched), checks };
	}
	const answer = requireAnswer(answers, condition.question, ruleLabel);
	const checks = condition.operators.map((operator) => ({
		...describeOperand(operator, thresholds),
		matched: evaluateOperator(operator, answer, condition.question, thresholds, ruleLabel),
	}));
	const value = answer.type === 'choice' ? answer.choice : answer.type === 'noul' ? answer.noul : answer.score;
	const confidence = answer.type === 'noul' ? undefined : bestEffortConfidence(answer);
	return {
		kind: 'question',
		question: condition.question,
		value,
		...(confidence !== undefined ? { confidence: roundConfidence(confidence) } : {}),
		matched: checks.every((check) => check.matched),
		checks,
	};
}

function describeOperand(operator: Operator | FactOperator, thresholds: ThresholdMap): Omit<TraceCheck, 'matched'> {
	if ('values' in operator) return { op: operator.op, expected: operator.values };
	const value = operator.value;
	if (value !== null && typeof value === 'object') {
		if (value.kind === 'number') return { op: operator.op, expected: value.value };
		return { op: operator.op, expected: thresholds[value.name], threshold: value.name };
	}
	return { op: operator.op, expected: value };
}

function evaluateOperator(
	operator: Operator,
	answer: AnswerView,
	question: string,
	thresholds: ThresholdMap,
	ruleLabel: string,
): boolean {
	if (operator.op === 'eq' || operator.op === 'neq') {
		const actual = requireChoice(answer, operator.op, question, ruleLabel);
		return operator.op === 'eq' ? actual === operator.value : actual !== operator.value;
	}
	if (operator.op === 'in' || operator.op === 'not_in') {
		const actual = requireChoice(answer, operator.op, question, ruleLabel);
		const found = operator.values.includes(actual);
		return operator.op === 'in' ? found : !found;
	}
	if (operator.op === 'confidence_gte' || operator.op === 'confidence_lt') {
		if (answer.type === 'noul') {
			throw new RulesError(
				`${ruleLabel} uses "${operator.op}" on question "${question}", which is a noul answer. Noul has no separate confidence field. Compare its probability with gte, gt, lte, or lt.`,
			);
		}
		const confidence = bestEffortConfidence(answer);
		if (confidence === undefined) {
			throw new RulesError(
				`${ruleLabel} uses "${operator.op}" on question "${question}", which has no confidence and no probabilities to derive one from.`,
			);
		}
		const expected = resolveThreshold(operator.value, thresholds, `${ruleLabel} question "${question}" ${operator.op}`);
		return operator.op === 'confidence_gte' ? confidence >= expected : confidence < expected;
	}

	if (operator.op === 'gte' || operator.op === 'gt' || operator.op === 'lte' || operator.op === 'lt') {
		if (answer.type === 'choice') {
			throw new RulesError(
				`${ruleLabel} uses "${operator.op}" on question "${question}", which is a choice answer. Compare choices with eq, neq, in, not_in, confidence_gte, or confidence_lt.`,
			);
		}
		const actual = answer.type === 'noul' ? answer.noul : answer.score;
		if (typeof actual !== 'number' || !Number.isFinite(actual)) {
			throw new RulesError(
				`${ruleLabel} question "${question}" is a ${answer.type} answer with no numeric ${answer.type} value.`,
			);
		}
		const expected = resolveThreshold(
			operator.value,
			thresholds,
			`${ruleLabel} question "${question}" ${operator.op}`,
		);
		switch (operator.op) {
			case 'gte':
				return actual >= expected;
			case 'gt':
				return actual > expected;
			case 'lte':
				return actual <= expected;
			case 'lt':
				return actual < expected;
			default:
				return assertNever(operator.op);
		}
	}

	throw new RulesError(`${ruleLabel} has an unsupported operator ${JSON.stringify(operator)}.`);
}

function requireChoice(answer: AnswerView, op: string, question: string, ruleLabel: string): string {
	if (answer.type !== 'choice') {
		throw new RulesError(
			`${ruleLabel} uses "${op}" on question "${question}", which is a ${answer.type} answer. eq, neq, in, and not_in apply to choice answers. Compare noul and score with gte, gt, lte, or lt.`,
		);
	}
	if (answer.choice === undefined) {
		throw new RulesError(`${ruleLabel} question "${question}" is a choice answer with no choice value.`);
	}
	return answer.choice;
}

/** Threshold names a validated ruleset references in conditions and action templates. */
export function referencedThresholds(ruleset: Ruleset): Set<string> {
	const names = new Set<string>();
	collectActionThresholds(ruleset.default_action, names);
	for (const rule of ruleset.rules) {
		collectConditionThresholds(rule.when, names);
		collectActionThresholds(rule.action, names);
	}
	return names;
}

function collectConditionThresholds(condition: Condition, into: Set<string>): void {
	if (condition.kind === 'all' || condition.kind === 'any') {
		for (const child of condition.conditions) collectConditionThresholds(child, into);
		return;
	}
	if (condition.kind === 'fact') {
		for (const operator of condition.operators) {
			if (operator.op === 'gte' || operator.op === 'gt' || operator.op === 'lte' || operator.op === 'lt') {
				if (operator.value.kind === 'threshold') into.add(operator.value.name);
			}
		}
		return;
	}
	for (const operator of condition.operators) {
		if (
			operator.op === 'gte' ||
			operator.op === 'gt' ||
			operator.op === 'lte' ||
			operator.op === 'lt' ||
			operator.op === 'confidence_gte' ||
			operator.op === 'confidence_lt'
		) {
			if (operator.value.kind === 'threshold') into.add(operator.value.name);
		}
	}
}

function collectActionThresholds(action: ActionSpec, into: Set<string>): void {
	collectTemplateThresholds(action.target, into);
	collectTemplateThresholds(action.reason, into);
}

function collectTemplateThresholds(text: string, into: Set<string>): void {
	const pattern = /\{\{\s*([^{}]+?)\s*\}\}/g;
	for (const match of text.matchAll(pattern)) {
		const parts = (match[1] ?? '').split('.').map((part) => part.trim());
		if (parts.length === 2 && parts[0] === 'thresholds' && parts[1] && IDENTIFIER.test(parts[1])) {
			into.add(parts[1]);
		}
	}
}

/** Facts are verified, so they do not lower confidence. A facts-only rule is 1. */
function confidenceFor(condition: Condition, answers: Record<string, AnswerView>): number {
	const questions = referencedQuestions(condition);
	if (questions.length === 0) return 1;
	let min = Number.POSITIVE_INFINITY;
	for (const question of questions) {
		const answer = answers[question];
		const score = answer ? (bestEffortConfidence(answer) ?? 0) : 0;
		if (score < min) min = score;
	}
	return roundConfidence(min);
}

function materialize(
	action: ActionSpec,
	answers: Record<string, AnswerView>,
	facts: FactMap,
	thresholds: ThresholdMap,
	matchedRule: string | null,
	confidence: number,
): EvaluationResult {
	const target = renderTemplate(action.target, answers, thresholds, facts);
	const reason = renderTemplate(action.reason, answers, thresholds, facts);
	const label = matchedRule === null ? 'default_action' : `rule "${matchedRule}"`;
	if (target.trim() === '' || reason.trim() === '') {
		throw new RulesError(
			`${label} rendered an empty target or reason. Check {{answers.<question>.choice}} and {{thresholds.<name>}} placeholders.`,
		);
	}
	return {
		action: action.type,
		target,
		reason,
		gate: action.gate,
		matched_rule: matchedRule,
		confidence: roundConfidence(confidence),
	};
}

/**
 * Replaces `{{answers.<id>.<field>}}`, `{{thresholds.<name>}}`, and
 * `{{facts.<path>}}`. A known path that does not resolve becomes an empty
 * string. Any other placeholder is left in place so a typo stays visible in
 * the output. Supported answer fields: choice, noul, score, confidence, type.
 * A fact renders only when it is a string, number, or boolean.
 */
export function renderTemplate(
	input: string,
	answers: Record<string, AnswerView>,
	thresholds: ThresholdMap,
	facts: FactMap = {},
): string {
	return input.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (full, rawPath: string) => {
		const parts = rawPath.split('.').map((part) => part.trim());
		if (parts.some((part) => part === '')) return full;
		if (parts[0] === 'answers' && parts.length === 3) {
			const answer = answers[parts[1]];
			if (!answer) return '';
			const field = parts[2];
			if (field === 'type') return answer.type;
			if (field === 'choice' || field === 'noul' || field === 'score' || field === 'confidence') {
				const value = answer[field];
				return value === undefined ? '' : String(value);
			}
			return '';
		}
		if (parts[0] === 'thresholds' && parts.length === 2) {
			if (!Object.prototype.hasOwnProperty.call(thresholds, parts[1])) return '';
			return String(thresholds[parts[1]]);
		}
		if (parts[0] === 'facts' && parts.length >= 2) {
			let current: unknown = facts;
			for (const segment of parts.slice(1)) {
				if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return '';
				current = current[segment];
			}
			return isFactValue(current) && current !== null ? String(current) : '';
		}
		return full;
	});
}

function resolveThreshold(ref: ThresholdRef, thresholds: ThresholdMap, path: string): number {
	if (ref.kind === 'number') return ref.value;
	if (!Object.prototype.hasOwnProperty.call(thresholds, ref.name)) {
		const known = Object.keys(thresholds);
		const listed = known.length > 0 ? known.join(', ') : '(none)';
		throw new RulesError(
			`${path} references threshold "${ref.name}". Add it under rules.thresholds or pass it as a threshold override. Defined thresholds: ${listed}.`,
		);
	}
	return thresholds[ref.name];
}

function mergeThresholds(
	base: Record<string, number>,
	overrides: Record<string, number> | undefined,
): ThresholdMap {
	const merged: ThresholdMap = Object.create(null);
	for (const [key, value] of Object.entries(base)) merged[key] = value;
	if (overrides === undefined) return merged;
	if (!isPlainObject(overrides)) {
		throw new RulesError('Threshold overrides must be an object of names to finite numbers.');
	}
	for (const [key, value] of Object.entries(overrides)) {
		assertIdentifier(key, `Threshold override "${key}"`);
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			throw new RulesError(`Threshold override "${key}" must be a finite number.`);
		}
		merged[key] = value;
	}
	return merged;
}

function readRule(input: unknown, path: string, seenIds: Set<string>): Rule {
	if (!isPlainObject(input)) {
		throw new RulesError(`${path} must be an object with id, when, and action.`);
	}
	assertKnownKeys(input, RULE_KEYS, path);
	if (typeof input.id !== 'string' || input.id.trim() === '' || /\s/.test(input.id)) {
		throw new RulesError(`${path}.id must be a non-empty string without spaces.`);
	}
	if (seenIds.has(input.id)) {
		throw new RulesError(`${path}.id duplicates "${input.id}". Rule ids must be unique.`);
	}
	seenIds.add(input.id);
	let description: string | undefined;
	if (input.description !== undefined) {
		if (typeof input.description !== 'string') {
			throw new RulesError(`${path}.description must be a string.`);
		}
		description = input.description;
	}
	if (input.when === undefined) {
		throw new RulesError(`${path}.when is required.`);
	}
	const when = readCondition(input.when, `${path}.when`, 0);
	const action = readAction(input.action, `${path}.action`);
	return description === undefined ? { id: input.id, when, action } : { id: input.id, description, when, action };
}

function readCondition(input: unknown, path: string, depth: number): Condition {
	if (depth > MAX_DEPTH) {
		throw new RulesError(`${path} nests conditions more than ${MAX_DEPTH} levels deep.`);
	}
	if (!isPlainObject(input)) {
		throw new RulesError(`${path} must be an object with "all", "any", "question", or "fact".`);
	}
	const hasAll = Object.prototype.hasOwnProperty.call(input, 'all');
	const hasAny = Object.prototype.hasOwnProperty.call(input, 'any');
	const hasQuestion = Object.prototype.hasOwnProperty.call(input, 'question');
	const hasFact = Object.prototype.hasOwnProperty.call(input, 'fact');
	const groupCount = Number(hasAll) + Number(hasAny) + Number(hasQuestion) + Number(hasFact);
	if (groupCount !== 1) {
		throw new RulesError(
			`${path} must contain exactly one of "all", "any", "question", or "fact". Found ${groupCount === 0 ? 'none' : 'more than one'}.`,
		);
	}
	if (hasFact) return readFactCondition(input, path);
	if (hasAll || hasAny) {
		const key = hasAll ? 'all' : 'any';
		assertKnownKeys(input, new Set([key]), path);
		const list = input[key];
		if (!Array.isArray(list) || list.length === 0) {
			throw new RulesError(`${path}.${key} must be a non-empty array of conditions.`);
		}
		const conditions = list.map((child, index) =>
			readCondition(child, `${path}.${key}[${index}]`, depth + 1),
		);
		return hasAll ? { kind: 'all', conditions } : { kind: 'any', conditions };
	}

	const allowed = new Set<string>(['question', ...OPERATOR_NAMES]);
	assertKnownKeys(input, allowed, path);
	if (typeof input.question !== 'string' || input.question === '' || /\s/.test(input.question)) {
		throw new RulesError(`${path}.question must be a non-empty question id without spaces.`);
	}

	const presentIdentity = IDENTITY_OPS.filter((name) => Object.prototype.hasOwnProperty.call(input, name));
	const presentNumeric = NUMERIC_OPS.filter((name) => Object.prototype.hasOwnProperty.call(input, name));
	const presentConfidence = CONFIDENCE_OPS.filter((name) => Object.prototype.hasOwnProperty.call(input, name));
	if (presentIdentity.length > 0 && presentNumeric.length > 0) {
		throw new RulesError(
			`${path} mixes choice operators (${presentIdentity.join(', ')}) with numeric operators (${presentNumeric.join(', ')}). A question is either a choice or a noul/score.`,
		);
	}
	if (presentIdentity.length + presentNumeric.length + presentConfidence.length === 0) {
		throw new RulesError(
			`${path} has no operator. Add one of: ${OPERATOR_NAMES.join(', ')}.`,
		);
	}

	const operators: Operator[] = [];
	for (const name of presentIdentity) {
		operators.push(readIdentityOperator(name, input[name], `${path}.${name}`));
	}
	for (const name of presentConfidence) {
		operators.push({ op: name, value: readNumericOperand(input[name], `${path}.${name}`) });
	}
	for (const name of presentNumeric) {
		operators.push({ op: name, value: readNumericOperand(input[name], `${path}.${name}`) });
	}
	return { kind: 'predicate', question: input.question, operators };
}

function readFactCondition(input: Record<string, unknown>, path: string): Condition {
	const present = Object.keys(input).filter((key) => key !== 'fact');
	for (const key of present) {
		if (key === 'confidence_gte' || key === 'confidence_lt') {
			throw new RulesError(
				`${path}.${key} applies to model answers. A fact is verified by the host and has no confidence. Use eq, neq, in, not_in, contains, not_contains, gte, gt, lte, or lt.`,
			);
		}
	}
	assertKnownKeys(input, new Set<string>(['fact', ...FACT_OPERATOR_NAMES]), path);
	if (typeof input.fact !== 'string' || input.fact === '') {
		throw new RulesError(`${path}.fact must be a fact path such as "touches_ci" or "grant.privileged".`);
	}
	const segments = input.fact.split('.');
	for (const segment of segments) {
		if (!FACT_SEGMENT.test(segment) || RESERVED_NAMES.has(segment)) {
			throw new RulesError(
				`${path}.fact "${input.fact}" is not a fact path. Each dotted segment starts with a letter or underscore and uses letters, digits, underscores, or hyphens.`,
			);
		}
	}
	if (present.length === 0) {
		throw new RulesError(`${path} has no operator. Add one of: ${FACT_OPERATOR_NAMES.join(', ')}.`);
	}

	// Fixed order, same as question predicates, so JSON key order cannot change the result.
	const operators: FactOperator[] = [];
	for (const name of FACT_OPERATOR_NAMES) {
		if (!Object.prototype.hasOwnProperty.call(input, name)) continue;
		const value = input[name];
		const opPath = `${path}.${name}`;
		if (name === 'eq' || name === 'neq' || name === 'contains' || name === 'not_contains') {
			operators.push({ op: name, value: readFactOperand(value, opPath) });
		} else if (name === 'in' || name === 'not_in') {
			if (!Array.isArray(value) || value.length === 0) {
				throw new RulesError(`${opPath} must be a non-empty array of strings, numbers, booleans, or null.`);
			}
			operators.push({ op: name, values: value.map((entry, index) => readFactOperand(entry, `${opPath}[${index}]`)) });
		} else {
			operators.push({ op: name, value: readNumericOperand(value, opPath) });
		}
	}
	return { kind: 'fact', fact: input.fact, path: segments, operators };
}

/** Fact operands are literal. A string is never a threshold name here. */
function readFactOperand(value: unknown, path: string): FactValue {
	if (isFactValue(value)) return value;
	throw new RulesError(`${path} must be a string, a finite number, a boolean, or null. Received ${describeValue(value)}.`);
}

function readIdentityOperator(op: 'eq' | 'neq' | 'in' | 'not_in', value: unknown, path: string): Operator {
	if (op === 'eq' || op === 'neq') {
		return { op, value: readLabel(value, path) };
	}
	if (!Array.isArray(value) || value.length === 0) {
		throw new RulesError(`${path} must be a non-empty array of choice labels.`);
	}
	return { op, values: value.map((entry, index) => readLabel(entry, `${path}[${index}]`)) };
}

function readLabel(value: unknown, path: string): string {
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	if (typeof value === 'string' && value !== '') return value;
	throw new RulesError(`${path} must be a non-empty choice label.`);
}

function readNumericOperand(value: unknown, path: string): ThresholdRef {
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new RulesError(`${path} must be a finite number.`);
		return { kind: 'number', value };
	}
	if (typeof value === 'string') {
		const template = THRESHOLD_TEMPLATE.exec(value.trim());
		if (template) return { kind: 'threshold', name: template[1] };
		if (IDENTIFIER.test(value) && !RESERVED_NAMES.has(value)) return { kind: 'threshold', name: value };
		if (value.trim() !== '' && Number.isFinite(Number(value))) {
			return { kind: 'number', value: Number(value) };
		}
		throw new RulesError(`${path} must be a number or a threshold name. Received ${JSON.stringify(value)}.`);
	}
	if (isPlainObject(value)) {
		assertKnownKeys(value, new Set(['threshold']), path);
		if (typeof value.threshold !== 'string') {
			throw new RulesError(`${path}.threshold must be a threshold name.`);
		}
		assertIdentifier(value.threshold, `${path}.threshold`);
		return { kind: 'threshold', name: value.threshold };
	}
	throw new RulesError(`${path} must be a number, a threshold name, or {"threshold":"name"}. Received ${describeValue(value)}.`);
}

function readAction(input: unknown, path: string): ActionSpec {
	if (!isPlainObject(input)) {
		throw new RulesError(`${path} must be an object with type, target, and reason.`);
	}
	assertKnownKeys(input, ACTION_KEYS, path);
	const type = readRequiredString(input.type, `${path}.type`);
	const target = readRequiredString(input.target, `${path}.target`);
	const reason = readRequiredString(input.reason, `${path}.reason`);
	let gate = false;
	if (input.gate !== undefined) {
		if (typeof input.gate !== 'boolean') {
			throw new RulesError(`${path}.gate must be a boolean.`);
		}
		gate = input.gate;
	}
	return { type, target, reason, gate };
}

function readRequiredString(value: unknown, path: string): string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new RulesError(`${path} must be a non-empty string.`);
	}
	return value.trim();
}

function readThresholdBlock(input: unknown, path: string): Record<string, number> {
	if (input === undefined) return {};
	if (!isPlainObject(input)) {
		throw new RulesError(`${path} must be an object of names to finite numbers.`);
	}
	const thresholds: Record<string, number> = {};
	for (const [key, value] of Object.entries(input)) {
		assertIdentifier(key, `${path}.${key}`);
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			throw new RulesError(`${path}.${key} must be a finite number.`);
		}
		thresholds[key] = value;
	}
	return thresholds;
}

function assertAnswerMap(answers: Record<string, AnswerView>): void {
	if (!isPlainObject(answers)) {
		throw new RulesError(`Answers must be an object keyed by question name. Received ${describeValue(answers)}.`);
	}
	for (const [key, answer] of Object.entries(answers)) {
		if (!answer || (answer.type !== 'choice' && answer.type !== 'noul' && answer.type !== 'score')) {
			throw new RulesError(`Answer "${key}" must be a normalized choice, noul, or score.`);
		}
	}
}

function assertIdentifier(name: string, path: string): void {
	if (!IDENTIFIER.test(name) || RESERVED_NAMES.has(name)) {
		throw new RulesError(
			`${path} must start with a letter or underscore and contain only letters, digits, and underscores.`,
		);
	}
}

function assertKnownKeys(input: Record<string, unknown>, allowed: Set<string>, path: string): void {
	for (const key of Object.keys(input)) {
		if (!allowed.has(key)) {
			throw new RulesError(`${path} has unknown key "${key}". Expected: ${[...allowed].join(', ')}.`);
		}
	}
}

function roundConfidence(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.round(value * 1e6) / 1e6;
}

function assertNever(value: never): never {
	throw new RulesError(`Unsupported operator ${JSON.stringify(value)}.`);
}
