import { describeValue, isPlainObject } from 'decision-matrix-rules';

import { SystemOneError } from './errors';

/** One System One question. `criteria` is required by choice and score servers. */
export interface SystemOneQuestion {
	type: 'choice' | 'noul' | 'score';
	instructions: string;
	criteria?: Record<string, string | null> | readonly string[];
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
	const questions: Record<string, unknown> = {};
	for (const [key, question] of Object.entries(value)) {
		if (key.trim() === '' || /\s/.test(key)) {
			throw new SystemOneError(`Question id "${key}" must be a non-empty string without spaces.`);
		}
		if (!isPlainObject(question)) {
			throw new SystemOneError(`questions.${key} must be an object with a type and instructions.`);
		}
		if (typeof question.type !== 'string' || question.type.trim() === '') {
			throw new SystemOneError(`questions.${key}.type is required. Use "choice", "noul", or "score".`);
		}
		questions[key] = question;
	}
	return questions;
}
