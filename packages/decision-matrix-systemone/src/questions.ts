import { describeValue, isPlainObject } from 'decision-matrix-rules';

import { SystemOneError } from './errors';

/** One System One question. `criteria` is required by choice and score servers. */
export interface SystemOneQuestion {
	type: 'choice' | 'noul' | 'score';
	instructions: string;
	criteria?: Record<string, string | null> | readonly string[];
}

function assertCriteria(key: string, type: 'choice' | 'noul' | 'score', criteria: unknown): void {
	const path = `questions.${key}.criteria`;
	if (type === 'noul') {
		if (criteria !== undefined) throw new SystemOneError(`${path} is not used by a noul question. Remove it, or make the question a choice or a score.`);
		return;
	}
	if (type === 'score') {
		if (!Array.isArray(criteria) || criteria.length < 2 || !criteria.every((level) => typeof level === 'string')) {
			throw new SystemOneError(`${path} must list at least two levels, lowest first, for a score question.`);
		}
		return;
	}
	if (Array.isArray(criteria)) {
		const labels = criteria as unknown[];
		if (labels.length === 0 || !labels.every((label) => typeof label === 'string' && label !== '') || new Set(labels).size !== labels.length) {
			throw new SystemOneError(`${path} must list at least one label, each non-empty and different.`);
		}
		return;
	}
	if (!isPlainObject(criteria) || Object.keys(criteria).length === 0) {
		throw new SystemOneError(`${path} must map each label to a description (or null) for a choice question.`);
	}
	for (const [label, description] of Object.entries(criteria)) {
		if (label === '') throw new SystemOneError(`${path} has an empty label.`);
		if (description !== null && typeof description !== 'string') {
			throw new SystemOneError(`${path}.${label} must be a description or null.`);
		}
	}
}

/**
 * State is a string, a JSON object, or a JSON array. A string that starts
 * with `{` or `[` is parsed as JSON. Any other string is sent as text.
 */
export function readState(value: unknown): unknown {
	if (isPlainObject(value) || Array.isArray(value)) return value;
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed === '') {
			throw new SystemOneError('State is required. Provide the text, object, or array to evaluate.');
		}
		if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed) as unknown;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new SystemOneError(`State looks like JSON but could not be parsed. ${message}`);
			}
			if (isPlainObject(parsed) || Array.isArray(parsed)) return parsed;
			throw new SystemOneError(
				'State JSON must be an object or an array. Send plain text without wrapping quotes when the state is a single string.',
			);
		}
		return value;
	}
	throw new SystemOneError(`State must be a string, object, or array. Received ${describeValue(value)}.`);
}

/** Checks a questions object keyed by question id. */
export function validateQuestions(value: unknown): Record<string, unknown> {
	if (!isPlainObject(value)) {
		throw new SystemOneError(
			`Questions must be a JSON object keyed by question id. Received ${describeValue(value)}.`,
		);
	}
	// Accepts exactly what schema/questions.schema.json accepts. `$schema` is for
	// editors and is not sent to the server.
	const questions: Record<string, unknown> = {};
	for (const [key, question] of Object.entries(value)) {
		if (key === '$schema') {
			if (typeof question !== 'string') throw new SystemOneError('questions.$schema must be a string.');
			continue;
		}
		if (key.trim() === '' || /\s/.test(key)) {
			throw new SystemOneError(`Question id "${key}" must be a non-empty string without spaces.`);
		}
		if (!isPlainObject(question)) {
			throw new SystemOneError(`questions.${key} must be an object with a type and instructions.`);
		}
		if (question.type !== 'choice' && question.type !== 'noul' && question.type !== 'score') {
			throw new SystemOneError(`questions.${key}.type must be "choice", "noul", or "score". Received ${JSON.stringify(question.type)}.`);
		}
		if (typeof question.instructions !== 'string' || question.instructions.trim() === '') {
			throw new SystemOneError(`questions.${key}.instructions must say what the model is asked.`);
		}
		assertCriteria(key, question.type, question.criteria);
		questions[key] = question;
	}
	if (Object.keys(questions).length === 0) {
		throw new SystemOneError('Questions must contain at least one question.');
	}
	return questions;
}
