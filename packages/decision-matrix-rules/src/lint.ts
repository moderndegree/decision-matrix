import { referencedQuestions, referencedThresholds, requiresFact, validateRuleset } from './engine';
import { RulesError } from './errors';
import { isPlainObject } from './object';
import type { Condition, FactOperator, FactValue, Operator, Ruleset, ThresholdRef } from './types';

/**
 * Static checks on a ruleset. Nothing is evaluated and no server is called.
 *
 * Errors are mistakes that break evaluation or make a rule silently dead,
 * such as a choice label that the question does not offer. Warnings are
 * policy risks, such as a rule the model alone can open, or a rule that an
 * earlier rule always beats. Info is cleanup.
 */

export type LintSeverity = 'error' | 'warning' | 'info';

export interface LintFinding {
	severity: LintSeverity;
	code: string;
	/** Rule id, when the finding is about one rule. */
	rule?: string;
	message: string;
}

/** The parts of a System One question the linter reads. */
export interface LintQuestion {
	type?: unknown;
	criteria?: unknown;
}

export interface LintOptions {
	/** When given, question ids, types, and choice labels are checked against it. */
	questions?: Record<string, LintQuestion>;
	thresholdOverrides?: Record<string, number>;
}

export function lintRuleset(input: unknown, options: LintOptions = {}): LintFinding[] {
	let ruleset: Ruleset;
	try {
		ruleset = validateRuleset(input);
	} catch (error) {
		if (error instanceof RulesError) return [{ severity: 'error', code: 'invalid', message: error.message }];
		throw error;
	}
	const thresholds: Record<string, number> = { ...ruleset.thresholds, ...(options.thresholdOverrides ?? {}) };
	const findings: LintFinding[] = [];
	const add = (severity: LintSeverity, code: string, message: string, rule?: string) => {
		findings.push(rule === undefined ? { severity, code, message } : { severity, code, rule, message });
	};

	for (const name of referencedThresholds(ruleset)) {
		if (!Object.prototype.hasOwnProperty.call(thresholds, name)) {
			add('error', 'unknown-threshold', `Threshold "${name}" is referenced but not defined.`);
		}
	}

	if (!ruleset.default_action.gate) {
		add(
			'warning',
			'default-opens-gate',
			'default_action has gate false, so an event that no rule recognizes proceeds. Hold by default when a miss should not proceed.',
		);
	}

	let firstModelRule: string | undefined;
	ruleset.rules.forEach((rule, index) => {
		const questions = referencedQuestions(rule.when);
		if (!rule.action.gate && !requiresFact(rule.when)) {
			add(
				'warning',
				'model-opens-gate',
				`Rule "${rule.id}" opens the gate on answers alone. Those answers are judgments about text, not facts the host verified. Require a fact under "all", or set open_gate_requires_facts when a verified fact must agree.`,
				rule.id,
			);
		}
		if (questions.length > 0) {
			firstModelRule ??= rule.id;
		} else if (firstModelRule !== undefined) {
			add(
				'info',
				'fact-rule-after-model-rule',
				`Rule "${rule.id}" reads only facts but comes after "${firstModelRule}", which reads answers. Move it above that rule to decide before any script or server call.`,
				rule.id,
			);
		}
		for (let earlier = 0; earlier < index; earlier++) {
			const shadow = ruleset.rules[earlier]!;
			if (implies(rule.when, shadow.when, thresholds)) {
				add(
					'warning',
					'shadowed',
					`Rule "${rule.id}" can never match: "${shadow.id}" comes first and matches whenever "${rule.id}" would.`,
					rule.id,
				);
				break;
			}
		}
	});

	if (options.questions) lintQuestions(ruleset, options.questions, add);

	const used = referencedThresholds(ruleset);
	for (const name of Object.keys(ruleset.thresholds)) {
		if (!used.has(name)) add('info', 'unused-threshold', `Threshold "${name}" is defined but no rule uses it.`);
	}
	return findings;
}

function lintQuestions(
	ruleset: Ruleset,
	questions: Record<string, LintQuestion>,
	add: (severity: LintSeverity, code: string, message: string, rule?: string) => void,
): void {
	const referenced = new Set<string>();
	for (const rule of ruleset.rules) {
		walkPredicates(rule.when, (question, operators) => {
			referenced.add(question);
			const definition = questions[question];
			if (!isPlainObject(definition)) {
				add('error', 'unknown-question', `Rule "${rule.id}" references question "${question}", which is not in the question set.`, rule.id);
				return;
			}
			const type = definition.type;
			for (const operator of operators) {
				const problem = operatorTypeProblem(operator.op, type);
				if (problem) {
					add('error', 'operator-type', `Rule "${rule.id}" uses ${operator.op} on "${question}", ${problem}`, rule.id);
				}
			}
			if (type === 'choice' && isPlainObject(definition.criteria)) {
				const labels = new Set(Object.keys(definition.criteria));
				for (const operator of operators) {
					const values = operator.op === 'in' || operator.op === 'not_in' ? operator.values : operator.op === 'eq' || operator.op === 'neq' ? [operator.value] : [];
					for (const label of values) {
						if (!labels.has(label)) {
							add(
								'error',
								'unknown-label',
								`Rule "${rule.id}" compares "${question}" with "${label}", which is not one of its options (${[...labels].join(', ')}). Labels are case-sensitive, so this never matches.`,
								rule.id,
							);
						}
					}
				}
			}
			if (type === 'score' && Array.isArray(definition.criteria)) {
				const top = definition.criteria.length - 1;
				for (const operator of operators) {
					const bound = numericBound(operator, ruleset.thresholds);
					if (bound !== undefined && (bound < 0 || bound > top + 1) && isValueOp(operator.op)) {
						add('warning', 'out-of-range', `Rule "${rule.id}" compares "${question}" with ${bound}, outside its levels 0–${top}.`, rule.id);
					}
				}
			}
			if (type === 'noul') {
				for (const operator of operators) {
					const bound = numericBound(operator, ruleset.thresholds);
					if (bound !== undefined && (bound < 0 || bound > 1)) {
						add('warning', 'out-of-range', `Rule "${rule.id}" compares the probability "${question}" with ${bound}, outside 0–1.`, rule.id);
					}
				}
			}
		});
	}
	for (const question of Object.keys(questions)) {
		if (!referenced.has(question)) {
			add('info', 'unused-question', `Question "${question}" is asked but no rule reads it. It costs tokens on every call.`);
		}
	}
}

function operatorTypeProblem(op: string, type: unknown): string | undefined {
	if (op === 'eq' || op === 'neq' || op === 'in' || op === 'not_in') {
		return type === 'choice' ? undefined : `which is a ${String(type)} question. Choice operators need a choice question.`;
	}
	if (op === 'confidence_gte' || op === 'confidence_lt') {
		return type === 'noul' ? 'which is a noul question. Compare its probability with gte, gt, lte, or lt.' : undefined;
	}
	return type === 'choice' ? 'which is a choice question. Numeric operators need a noul or score question.' : undefined;
}

function isValueOp(op: string): boolean {
	return op === 'gte' || op === 'gt' || op === 'lte' || op === 'lt';
}

function numericBound(operator: Operator, thresholds: Record<string, number>): number | undefined {
	if (!('value' in operator) || typeof operator.value !== 'object') return undefined;
	return resolve(operator.value, thresholds);
}

function walkPredicates(condition: Condition, visit: (question: string, operators: Operator[]) => void): void {
	if (condition.kind === 'predicate') visit(condition.question, condition.operators);
	else if (condition.kind === 'all' || condition.kind === 'any') {
		for (const child of condition.conditions) walkPredicates(child, visit);
	}
}

// --- Shadowing --------------------------------------------------------------
//
// Rule B can never win when an earlier rule A matches whenever B does, that is
// when B implies A. The check is sound but not complete: it only uses atoms B
// is guaranteed to have (those under "all" from the root), and compares each
// with A written as an OR of ANDs. A missed case is a missing warning, never a
// false one.

type Atom =
	| { subject: string; kind: 'num'; op: 'gte' | 'gt' | 'lte' | 'lt'; n: number }
	| { subject: string; kind: 'in' | 'not_in'; values: FactValue[] }
	| { subject: string; kind: 'contains' | 'not_contains'; value: FactValue };

const MAX_BRANCHES = 64;

/**
 * True when every input that satisfies `b` also satisfies `a`. Each side
 * resolves threshold names against its own map, so two versions of a ruleset
 * can be compared. Sound, not complete: false can mean "not proven".
 */
export function implies(
	b: Condition,
	a: Condition,
	thresholds: Record<string, number>,
	thresholdsA: Record<string, number> = thresholds,
): boolean {
	const guaranteed = guaranteedAtoms(b, thresholds);
	if (guaranteed.length === 0) return false;
	const branches = branchesOf(a, thresholdsA);
	if (branches === null) return false;
	return branches.some((branch) => branch.every((needed) => guaranteed.some((have) => atomImplies(have, needed))));
}

function guaranteedAtoms(condition: Condition, thresholds: Record<string, number>): Atom[] {
	if (condition.kind === 'all') return condition.conditions.flatMap((child) => guaranteedAtoms(child, thresholds));
	if (condition.kind === 'any') return condition.conditions.length === 1 ? guaranteedAtoms(condition.conditions[0]!, thresholds) : [];
	return atomsOf(condition, thresholds) ?? [];
}

function branchesOf(condition: Condition, thresholds: Record<string, number>): Atom[][] | null {
	if (condition.kind === 'any') {
		const all: Atom[][] = [];
		for (const child of condition.conditions) {
			const branches = branchesOf(child, thresholds);
			if (branches === null) return null;
			all.push(...branches);
			if (all.length > MAX_BRANCHES) return null;
		}
		return all;
	}
	if (condition.kind === 'all') {
		let product: Atom[][] = [[]];
		for (const child of condition.conditions) {
			const branches = branchesOf(child, thresholds);
			if (branches === null) return null;
			product = product.flatMap((left) => branches.map((right) => [...left, ...right]));
			if (product.length > MAX_BRANCHES) return null;
		}
		return product;
	}
	const atoms = atomsOf(condition, thresholds);
	return atoms === null ? null : [atoms];
}

function atomsOf(condition: Extract<Condition, { kind: 'predicate' | 'fact' }>, thresholds: Record<string, number>): Atom[] | null {
	const atoms: Atom[] = [];
	const base = condition.kind === 'fact' ? `fact:${condition.fact}` : `question:${condition.question}`;
	for (const operator of condition.operators as Array<Operator | FactOperator>) {
		const op = operator.op;
		if (op === 'eq' || op === 'neq') {
			atoms.push({ subject: base, kind: op === 'eq' ? 'in' : 'not_in', values: [(operator as { value: FactValue }).value] });
		} else if (op === 'in' || op === 'not_in') {
			atoms.push({ subject: base, kind: op, values: (operator as { values: FactValue[] }).values });
		} else if (op === 'contains' || op === 'not_contains') {
			atoms.push({ subject: base, kind: op, value: (operator as { value: FactValue }).value });
		} else {
			const n = resolve((operator as { value: ThresholdRef }).value, thresholds);
			if (n === undefined) return null;
			const confidence = op === 'confidence_gte' || op === 'confidence_lt';
			const numericOp = op === 'confidence_gte' ? 'gte' : op === 'confidence_lt' ? 'lt' : op;
			atoms.push({ subject: confidence ? `confidence:${base}` : base, kind: 'num', op: numericOp, n });
		}
	}
	return atoms;
}

function atomImplies(have: Atom, needed: Atom): boolean {
	if (have.subject !== needed.subject) return false;
	if (have.kind === 'num' && needed.kind === 'num') {
		const lower = (op: string) => op === 'gte' || op === 'gt';
		if (lower(have.op) !== lower(needed.op)) return false;
		if (lower(have.op)) {
			// x >= h (or > h) implies x >= n when h >= n, and x > n when h > n (or h >= n for >).
			return needed.op === 'gte' ? have.n >= needed.n : have.op === 'gt' ? have.n >= needed.n : have.n > needed.n;
		}
		return needed.op === 'lte' ? have.n <= needed.n : have.op === 'lt' ? have.n <= needed.n : have.n < needed.n;
	}
	const same = (x: FactValue, y: FactValue) => x === y;
	if (have.kind === 'in' && needed.kind === 'in') return have.values.every((v) => needed.values.some((w) => same(v, w)));
	if (have.kind === 'in' && needed.kind === 'not_in') return have.values.every((v) => !needed.values.some((w) => same(v, w)));
	if (have.kind === 'not_in' && needed.kind === 'not_in') return needed.values.every((w) => have.values.some((v) => same(v, w)));
	if ((have.kind === 'contains' || have.kind === 'not_contains') && have.kind === needed.kind) {
		return same(have.value, (needed as { value: FactValue }).value);
	}
	return false;
}

function resolve(ref: ThresholdRef, thresholds: Record<string, number>): number | undefined {
	if (ref.kind === 'number') return ref.value;
	return Object.prototype.hasOwnProperty.call(thresholds, ref.name) ? thresholds[ref.name] : undefined;
}
