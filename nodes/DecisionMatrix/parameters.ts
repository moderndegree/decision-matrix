import { RulesError, isPlainObject } from 'decision-matrix-rules';
import {
	GENERIC_TRIAGE_QUESTIONS,
	readState,
	SDLC_QUESTIONS,
	SUPPORT_OPS_QUESTIONS,
	SystemOneError,
	validateQuestions,
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
