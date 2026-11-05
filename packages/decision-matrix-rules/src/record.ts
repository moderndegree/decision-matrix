import { createHash } from 'node:crypto';

import { referencedFacts, referencedQuestions } from './engine';
import { RulesError } from './errors';
import type { ActionSpec, Condition, EvaluationResult, FactOperator, Operator, Ruleset } from './types';

/**
 * A caller-owned receipt. It names the ruleset, the decision, and which
 * fact paths and question ids were read. It does not contain fact values,
 * model text, or a log of the event.
 */
export interface DecisionReceipt {
	ruleset_hash: string;
	matched_rule: string | null;
	action: string;
	gate: boolean;
	fact_paths: string[];
	question_ids: string[];
	/** Set when evaluation failed. Distinct from a hold, which has gate true and no error. */
	error?: string;
}

/** sha256 of the validated ruleset object. Key order is the order validateRuleset builds. */
export function rulesetHash(ruleset: Ruleset): string {
	return createHash('sha256').update(JSON.stringify(ruleset)).digest('hex');
}

/**
 * Paths and question ids from rules up to and including the winner.
 * When nothing matched, every rule was evaluated, so every path is listed.
 */
export function decisionReceipt(
	ruleset: Ruleset,
	decision: Pick<EvaluationResult, 'matched_rule' | 'action' | 'gate'>,
	error?: string,
): DecisionReceipt {
	const fact_paths: string[] = [];
	const question_ids: string[] = [];
	for (const rule of ruleset.rules) {
		for (const path of referencedFacts(rule.when)) if (!fact_paths.includes(path)) fact_paths.push(path);
		for (const id of referencedQuestions(rule.when)) if (!question_ids.includes(id)) question_ids.push(id);
		if (decision.matched_rule !== null && rule.id === decision.matched_rule) break;
	}
	return {
		ruleset_hash: rulesetHash(ruleset),
		matched_rule: decision.matched_rule,
		action: decision.action,
		gate: decision.gate,
		fact_paths,
		question_ids,
		...(error ? { error } : {}),
	};
}

/**
 * Question ids read by a rule that opens the gate, when the ruleset says a
 * model answer cannot open the gate by itself. A script may answer these
 * for a hold. It must not be the only answer when the decision could open:
 * the caller still sends them to the server, and the server answer wins.
 */
export function questionsScriptsCannotOpen(ruleset: Ruleset): string[] {
	if (ruleset.open_gate_requires_facts !== true) return [];
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const rule of ruleset.rules) {
		if (rule.action.gate) continue;
		for (const id of referencedQuestions(rule.when)) {
			if (seen.has(id)) continue;
			seen.add(id);
			ids.push(id);
		}
	}
	return ids;
}

export interface TableRow {
	id: string;
	/** True when the condition is a flat conjunction of predicates. Nested all/any is not flat. */
	flat: boolean;
	when: string;
	action: string;
	target: string;
	gate: boolean;
}

/** A read-only projection. Flat conjunctions become one line. Anything nested stays `(tree)`. */
export function projectTable(ruleset: Ruleset): { rows: TableRow[]; default_action: ActionSpec } {
	return {
		rows: ruleset.rules.map((rule) => {
			const when = flatWhen(rule.when);
			return {
				id: rule.id,
				flat: when !== undefined,
				when: when ?? '(tree)',
				action: rule.action.type,
				target: rule.action.target,
				gate: rule.action.gate,
			};
		}),
		default_action: ruleset.default_action,
	};
}

/** The flat-conjunction line, or undefined when the condition is a tree. */
export function flatWhen(condition: Condition): string | undefined {
	if (condition.kind === 'predicate' || condition.kind === 'fact') return formatAtom(condition);
	if (condition.kind !== 'all') return undefined;
	if (!condition.conditions.every((child) => child.kind === 'predicate' || child.kind === 'fact')) return undefined;
	return condition.conditions.map((child) => formatAtom(child)).join(' AND ');
}

function formatAtom(condition: Extract<Condition, { kind: 'predicate' | 'fact' }>): string {
	const subject = condition.kind === 'fact' ? condition.fact : condition.question;
	const ops = (condition.operators as Array<Operator | FactOperator>).map(formatOperator).join(' AND ');
	return `${subject} ${ops}`;
}

function formatOperator(operator: Operator | FactOperator): string {
	if ('values' in operator) return `${operator.op} ${operator.values.map(formatScalar).join(', ')}`;
	const value = operator.value;
	if (value !== null && typeof value === 'object') {
		if (value.kind === 'number') return `${operator.op} ${value.value}`;
		if (value.kind === 'instant') return `${operator.op} ${new Date(value.ms).toISOString()}`;
		return `${operator.op} ${value.name}`;
	}
	return `${operator.op} ${formatScalar(value)}`;
}

function formatScalar(value: unknown): string {
	if (typeof value === 'string' && /^[A-Za-z0-9_.:@+/-]+$/.test(value)) return value;
	if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
	return JSON.stringify(value);
}

const CLOSED_OPERATORS = new Set([
	'eq',
	'neq',
	'in',
	'not_in',
	'contains',
	'not_contains',
	'gte',
	'gt',
	'lte',
	'lt',
	'confidence_gte',
	'confidence_lt',
]);
const FACT_OPERATORS = new Set(['eq', 'neq', 'in', 'not_in', 'contains', 'not_contains', 'gte', 'gt', 'lte', 'lt']);
const QUESTION_OPERATORS = new Set(['eq', 'neq', 'in', 'not_in', 'gte', 'gt', 'lte', 'lt', 'confidence_gte', 'confidence_lt']);

/** One unary cell. The operator is one name from the closed set. */
export interface FlatCell {
	subject: string;
	source: 'fact' | 'question';
	operator: string;
	value: unknown;
}

/** One rule of flat cells and a single combine. Nested groups are not representable here. */
export interface FlatRow {
	id: string;
	combine: 'all' | 'any';
	conditions: FlatCell[];
	action: { type: string; target: string; reason: string; gate?: boolean };
}

/**
 * Compiles flat rows into the rules array validateRuleset reads.
 * An operator outside the closed set, a nested group, or a cell with more
 * than one comparison fails the file.
 */
export function compileFlatRows(rows: FlatRow[]): unknown[] {
	if (!Array.isArray(rows)) throw new RulesError('Rule rows must be an array.');
	return rows.map((row, index) => {
		const label = `Rule row ${index + 1}`;
		if (!row || typeof row !== 'object') throw new RulesError(`${label} must be an object.`);
		if (typeof row.id !== 'string' || row.id.trim() === '') throw new RulesError(`${label} is missing an id.`);
		if (row.combine !== 'all' && row.combine !== 'any') {
			throw new RulesError(`${label} combine must be "all" or "any". Nested groups are not accepted here.`);
		}
		if (!Array.isArray(row.conditions) || row.conditions.length === 0) {
			throw new RulesError(`${label} needs at least one condition.`);
		}
		const cells = row.conditions.map((cell, cellIndex) => compileCell(cell, `${label} condition ${cellIndex + 1}`));
		const when = cells.length === 1 ? cells[0] : { [row.combine]: cells };
		const action = row.action;
		if (!action || typeof action !== 'object') throw new RulesError(`${label} is missing an action.`);
		return { id: row.id.trim(), when, action };
	});
}

function compileCell(cell: FlatCell, label: string): Record<string, unknown> {
	if (!cell || typeof cell !== 'object' || Array.isArray(cell)) throw new RulesError(`${label} must be one comparison.`);
	const keys = Object.keys(cell);
	for (const key of keys) {
		if (key !== 'subject' && key !== 'source' && key !== 'operator' && key !== 'value') {
			throw new RulesError(`${label} has unknown key "${key}". A cell is one subject, one operator, and one value.`);
		}
	}
	if (cell.source !== 'fact' && cell.source !== 'question') {
		throw new RulesError(`${label} source must be "fact" or "question".`);
	}
	if (typeof cell.subject !== 'string' || cell.subject.trim() === '') throw new RulesError(`${label} is missing a subject.`);
	if (typeof cell.operator !== 'string' || !CLOSED_OPERATORS.has(cell.operator)) {
		throw new RulesError(`${label} has unknown operator ${JSON.stringify(cell.operator)}.`);
	}
	const allowed = cell.source === 'fact' ? FACT_OPERATORS : QUESTION_OPERATORS;
	if (!allowed.has(cell.operator)) {
		throw new RulesError(`${label} uses ${cell.operator} on a ${cell.source}. That operator is not in the closed set for a ${cell.source}.`);
	}
	if ((cell.operator === 'in' || cell.operator === 'not_in') && !Array.isArray(cell.value)) {
		throw new RulesError(`${label} ${cell.operator} needs an array value.`);
	}
	const key = cell.source === 'fact' ? 'fact' : 'question';
	return { [key]: cell.subject.trim(), [cell.operator]: cell.value };
}
