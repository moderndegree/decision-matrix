import { RulesError, compileFlatRows, isPlainObject, type FlatCell, type FlatRow } from 'decision-matrix-rules';
import {
	GENERIC_TRIAGE_QUESTIONS,
	GENERIC_TRIAGE_SCRIPTS,
	readState,
	SDLC_QUESTIONS,
	SDLC_SCRIPTS,
	SUPPORT_OPS_QUESTIONS,
	SUPPORT_OPS_SCRIPTS,
	SystemOneError,
	validateQuestions,
	validateScripts,
	type ScriptProgram,
	type SystemOneQuestion,
} from 'decision-matrix-systemone';

export type { SystemOneQuestion };
export { readState };

export interface ResolvedOptions {
	timeout: number;
	includeFullAnswers: boolean;
	failOnNoMatch: boolean;
	includeRawResponse: boolean;
	model?: string;
}

export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * A non-empty Questions object always replaces the selected preset.
 * An empty value uses the preset. "Custom JSON" with an empty value uses
 * generic triage, which is also the default preset.
 */
export function readQuestions(questionSet: unknown, custom: unknown): Record<string, unknown> {
	const override = readQuestionOverride(custom);
	if (override) return override;

	const selected = questionSet === undefined || questionSet === null || questionSet === '' ? 'generic' : questionSet;
	if (selected === 'generic' || selected === 'custom') return cloneQuestions(GENERIC_TRIAGE_QUESTIONS);
	if (selected === 'sdlc') return cloneQuestions(SDLC_QUESTIONS);
	if (selected === 'support') return cloneQuestions(SUPPORT_OPS_QUESTIONS);
	throw new SystemOneError(
		`Question set "${String(selected)}" is unknown. Choose Generic Triage, SDLC Change, Support / Ops, or Custom JSON.`,
	);
}

/**
 * Server sends every question. Scripts answer locally, and the server is
 * asked only for questions the script leaves open. An empty Scripts value
 * uses the built-in script for Generic Triage, SDLC Change, or Support / Ops.
 */
export function readScripts(
	answerWith: unknown,
	questionSet: unknown,
	scriptsParam: unknown,
	questionsParam: unknown,
): ScriptProgram | undefined {
	if (readAnswerWith(answerWith) === 'server') return undefined;
	const parsed = parseJsonParameter(scriptsParam, 'Scripts');
	const empty = parsed === undefined || (isPlainObject(parsed) && Object.keys(parsed).length === 0);
	const document = empty ? builtinScripts(questionSet, questionsParam) : parsed;
	return validateScripts(document, readQuestions(questionSet, questionsParam));
}

export function readAnswerWith(value: unknown): 'server' | 'scripts' {
	if (value === undefined || value === null || value === '' || value === 'server') return 'server';
	if (value === 'scripts') return 'scripts';
	throw new SystemOneError(`Answer With "${String(value)}" is unknown. Choose Server or Scripts.`);
}

function builtinScripts(questionSet: unknown, questionsParam: unknown): unknown {
	if (readQuestionOverride(questionsParam)) {
		throw new SystemOneError(
			'Scripts are empty, and Questions replaces the preset. Paste a scripts document, or clear Questions to use the built-in script.',
		);
	}
	const selected = questionSet === undefined || questionSet === null || questionSet === '' ? 'generic' : questionSet;
	const name = selected === 'custom' ? 'generic' : selected;
	if (name === 'generic') return GENERIC_TRIAGE_SCRIPTS;
	if (name === 'sdlc') return SDLC_SCRIPTS;
	if (name === 'support') return SUPPORT_OPS_SCRIPTS;
	throw new SystemOneError(
		`Question set "${String(selected)}" has no built-in script. Choose Generic Triage, SDLC Change, or Support / Ops, or paste a scripts document.`,
	);
}

function readQuestionOverride(custom: unknown): Record<string, unknown> | undefined {
	const parsed = parseJsonParameter(custom, 'Questions');
	if (parsed === undefined) return undefined;
	if (isPlainObject(parsed) && Object.keys(parsed).length === 0) return undefined;
	return validateQuestions(parsed);
}

/** Parses the Rules parameter. Structural checks happen in `validateRuleset`. */
export function readRulesInput(value: unknown): unknown {
	const parsed = parseJsonParameter(value, 'Rules');
	if (parsed === undefined) {
		throw new RulesError('Rules are required. Provide a version 1 ruleset with default_action and rules.');
	}
	return parsed;
}

/** Fixed-collection rows from the Thresholds parameter. Later rows do not override earlier ones; duplicates error. */
export function readThresholdOverrides(value: unknown): Record<string, number> {
	if (value === undefined || value === null || value === '') return {};
	if (!isPlainObject(value)) {
		throw new RulesError('Thresholds must be a collection of name and value rows.');
	}
	if (value.threshold === undefined) return {};
	if (!Array.isArray(value.threshold)) {
		throw new RulesError('Thresholds must be a collection of name and value rows.');
	}
	const overrides: Record<string, number> = {};
	value.threshold.forEach((row, index) => {
		const label = `Thresholds row ${index + 1}`;
		if (!isPlainObject(row)) throw new RulesError(`${label} must have a name and a value.`);
		if (typeof row.name !== 'string' || row.name.trim() === '') {
			throw new RulesError(`${label} is missing a name.`);
		}
		const name = row.name.trim();
		if (Object.prototype.hasOwnProperty.call(overrides, name)) {
			throw new RulesError(`Threshold "${name}" is defined more than once in Thresholds.`);
		}
		if (typeof row.value !== 'number' || !Number.isFinite(row.value)) {
			throw new RulesError(`Threshold "${name}" must be a finite number.`);
		}
		overrides[name] = row.value;
	});
	return overrides;
}

/** Parses the Facts parameter. Empty is no facts. Fact paths are checked by the engine. */
export function readFactsInput(value: unknown): Record<string, unknown> {
	const parsed = parseJsonParameter(value, 'Facts');
	if (parsed === undefined) return {};
	if (!isPlainObject(parsed)) {
		throw new RulesError('Facts must be a JSON object keyed by fact name.');
	}
	return parsed;
}

export function readOptions(value: unknown): ResolvedOptions {
	if (value === undefined || value === null || value === '') {
		return defaultOptions();
	}
	if (!isPlainObject(value)) {
		throw new SystemOneError('Options must be a collection of node options.');
	}
	const timeout = value.timeout === undefined || value.timeout === '' ? DEFAULT_TIMEOUT_MS : value.timeout;
	if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 1) {
		throw new SystemOneError('Timeout (ms) must be a finite number of milliseconds, at least 1.');
	}
	const model = typeof value.model === 'string' ? value.model.trim() : '';
	return {
		timeout,
		includeFullAnswers: readBoolean(value.includeFullAnswers, true, 'Include full answers in output'),
		failOnNoMatch: readBoolean(value.failOnNoMatch, false, 'Fail on no matching rule'),
		includeRawResponse: readBoolean(value.includeRawResponse, false, 'Include raw response'),
		...(model ? { model } : {}),
	};
}

function defaultOptions(): ResolvedOptions {
	return {
		timeout: DEFAULT_TIMEOUT_MS,
		includeFullAnswers: true,
		failOnNoMatch: false,
		includeRawResponse: false,
	};
}

function readBoolean(value: unknown, fallback: boolean, label: string): boolean {
	if (value === undefined || value === null || value === '') return fallback;
	if (typeof value === 'boolean') return value;
	throw new SystemOneError(`${label} must be a boolean.`);
}

function parseJsonParameter(value: unknown, label: string): unknown {
	if (value === undefined || value === null) return undefined;
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed === '') return undefined;
		try {
			return JSON.parse(trimmed) as unknown;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw label === 'Rules' || label === 'Facts'
				? new RulesError(`${label} are not valid JSON. ${message}`)
				: new SystemOneError(`${label} are not valid JSON. ${message}`);
		}
	}
	return value;
}

function cloneQuestions(preset: object): Record<string, unknown> {
	return JSON.parse(JSON.stringify(preset)) as Record<string, unknown>;
}

/**
 * Empty rule rows keep the Rules JSON. A non-empty collection replaces the
 * `rules` array and keeps version, thresholds, default_action, owner, ticket,
 * fact_schema, agreements, and open_gate_requires_facts from that JSON.
 */
export function applyRuleRows(rules: unknown, rowsParam: unknown): unknown {
	const rows = readRuleRows(rowsParam);
	if (rows.length === 0) return rules;
	if (!isPlainObject(rules)) throw new RulesError('Rules must be a JSON object when rule rows replace them.');
	return { ...rules, rules: compileFlatRows(rows) };
}

/** n8n fixed-collection shape: `{ rule: [{ id, combine, type, target, reason, gate, conditions: { condition: [...] } }] }`. */
export function readRuleRows(value: unknown): FlatRow[] {
	if (value === undefined || value === null || value === '') return [];
	if (!isPlainObject(value)) throw new RulesError('Rule rows must be a collection of rules.');
	if (value.rule === undefined) return [];
	if (!Array.isArray(value.rule)) throw new RulesError('Rule rows must be a collection of rules.');
	return value.rule.map((row, index) => compileRuleRow(row, index));
}

function compileRuleRow(row: unknown, index: number): FlatRow {
	const label = `Rule row ${index + 1}`;
	if (!isPlainObject(row)) throw new RulesError(`${label} must be an object.`);
	if (typeof row.id !== 'string' || row.id.trim() === '') throw new RulesError(`${label} is missing an id.`);
	if (row.combine !== 'all' && row.combine !== 'any') {
		throw new RulesError(`${label} combine must be "all" or "any". Nested groups stay in the Rules JSON.`);
	}
	if (typeof row.type !== 'string' || row.type.trim() === '') throw new RulesError(`${label} is missing an action type.`);
	if (typeof row.target !== 'string') throw new RulesError(`${label} is missing a target.`);
	if (typeof row.reason !== 'string') throw new RulesError(`${label} is missing a reason.`);
	if (typeof row.gate !== 'boolean') throw new RulesError(`${label} gate must be a boolean.`);
	return {
		id: row.id.trim(),
		combine: row.combine,
		conditions: readCells(row.conditions, label),
		action: { type: row.type.trim(), target: row.target, reason: row.reason, gate: row.gate },
	};
}

function readCells(value: unknown, label: string): FlatCell[] {
	if (!isPlainObject(value) || !Array.isArray(value.condition) || value.condition.length === 0) {
		throw new RulesError(`${label} needs at least one condition.`);
	}
	return value.condition.map((cell, index) => {
		const cellLabel = `${label} condition ${index + 1}`;
		if (!isPlainObject(cell)) throw new RulesError(`${cellLabel} must be one comparison.`);
		if (cell.source !== 'fact' && cell.source !== 'question') {
			throw new RulesError(`${cellLabel} source must be "fact" or "question".`);
		}
		if (typeof cell.subject !== 'string' || cell.subject.trim() === '') throw new RulesError(`${cellLabel} is missing a subject.`);
		if (typeof cell.operator !== 'string') throw new RulesError(`${cellLabel} is missing an operator.`);
		return {
			subject: cell.subject.trim(),
			source: cell.source,
			operator: cell.operator,
			value: parseCellValue(cell.value),
		};
	});
}

/** JSON true, false, null, a number, or an array. Anything else stays text, including threshold names. */
function parseCellValue(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	const trimmed = value.trim();
	if (trimmed === '') return '';
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (parsed === true || parsed === false || parsed === null) return parsed;
		if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed;
		if (Array.isArray(parsed)) return parsed;
	} catch {
		// Threshold names and other text stay strings.
	}
	return trimmed;
}
