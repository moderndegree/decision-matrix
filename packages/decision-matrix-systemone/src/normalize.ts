import { describeValue, isPlainObject, type AnswerView } from 'decision-matrix-rules';

import { SystemOneError } from './errors';

export interface UsageView {
	input_tokens?: number;
	output_tokens?: number;
}

export interface SystemOneResult {
	answers: Record<string, AnswerView>;
	/** Server answers object, unchanged, for the node output. */
	rawAnswers: Record<string, unknown>;
	usage?: UsageView;
	model?: string;
}

/**
 * Reads a System One response. Tolerates small dialect differences:
 * a missing `type` when `choice` / `noul` / `score` is present, numeric
 * strings, `prompt_tokens` / `completion_tokens` usage aliases, probability
 * arrays, and an `answers` map nested under `data` or `result`.
 * The original answers object is preserved on `rawAnswers`.
 */
export function normalizeSystemOneResponse(body: unknown): SystemOneResult {
	const envelope = extractEnvelope(body);
	if (Array.isArray(envelope.answers)) {
		throw new SystemOneError(
			'Decision server returned answers as an array. The System One protocol expects a map keyed by question name. A Decisions-style list is not evaluated here.',
		);
	}
	if (!isPlainObject(envelope.answers)) {
		throw new SystemOneError(
			`Decision server response has no answers object. Expected { "answers": { "<question>": { "type": "choice|noul|score", ... } } }. Received ${describeValue(envelope.answers)} for answers.`,
		);
	}

	const answers: Record<string, AnswerView> = {};
	for (const [key, value] of Object.entries(envelope.answers)) {
		answers[key] = normalizeAnswer(key, value);
	}

	const usage = normalizeUsage(envelope.usage);
	const model = typeof envelope.model === 'string' && envelope.model.trim() !== '' ? envelope.model : undefined;
	return {
		answers,
		rawAnswers: envelope.answers,
		...(usage ? { usage } : {}),
		...(model ? { model } : {}),
	};
}

function extractEnvelope(body: unknown): { answers: unknown; usage: unknown; model: unknown } {
	const parsed = coerceJsonObject(body);
	if (parsed.answers !== undefined) {
		return { answers: parsed.answers, usage: parsed.usage, model: parsed.model };
	}
	for (const wrapper of ['data', 'result'] as const) {
		const nested = parsed[wrapper];
		if (isPlainObject(nested) && nested.answers !== undefined) {
			return {
				answers: nested.answers,
				usage: nested.usage !== undefined ? nested.usage : parsed.usage,
				model: nested.model !== undefined ? nested.model : parsed.model,
			};
		}
	}
	throw new SystemOneError(
		'Decision server response has no answers object. Expected a System One body shaped as { "answers": { "<question>": { ... } }, "usage": { "input_tokens": 0, "output_tokens": 0 } }.',
	);
}

function coerceJsonObject(body: unknown): Record<string, unknown> {
	if (typeof body === 'string') {
		const trimmed = body.trim();
		if (trimmed === '') {
			throw new SystemOneError('Decision server returned an empty body.');
		}
		try {
			return coerceJsonObject(JSON.parse(trimmed) as unknown);
		} catch (error) {
			if (error instanceof SystemOneError) throw error;
			throw new SystemOneError('Decision server returned a response that is not JSON.');
		}
	}
	if (!isPlainObject(body)) {
		throw new SystemOneError(
			`Decision server returned ${describeValue(body)}. Expected a JSON object with an answers map.`,
		);
	}
	return body;
}

function normalizeAnswer(key: string, value: unknown): AnswerView {
	const path = `answers.${key}`;
	if (!isPlainObject(value)) {
		throw new SystemOneError(`${path} must be an object. Received ${describeValue(value)}.`);
	}
	const type = detectType(key, value);
	const probabilities = readProbabilityMap(value.probabilities, `${path}.probabilities`);
	const confidence = readOptionalNumber(value.confidence ?? value.confidence_score, `${path}.confidence`);

	if (type === 'choice') {
		const choice = readChoice(value, probabilities, path);
		return {
			type,
			choice,
			...(confidence !== undefined ? { confidence } : {}),
			...(probabilities ? { probabilities } : {}),
		};
	}
	if (type === 'noul') {
		const noul = readRequiredNumber(
			firstDefined(value, ['noul', 'probability', 'yes', 'p']),
			`${path}.noul`,
			true,
		);
		return {
			type,
			noul,
			...(confidence !== undefined ? { confidence } : {}),
			...(probabilities ? { probabilities } : {}),
		};
	}
	const score = readRequiredNumber(firstDefined(value, ['score', 'value']), `${path}.score`, false);
	return {
		type,
		score,
		...(confidence !== undefined ? { confidence } : {}),
		...(probabilities ? { probabilities } : {}),
	};
}

function detectType(key: string, value: Record<string, unknown>): AnswerView['type'] {
	const declared = value.type ?? value.Type;
	if (typeof declared === 'string' && declared.trim() !== '') {
		const normalized = declared.trim().toLowerCase();
		if (normalized === 'choice' || normalized === 'noul' || normalized === 'score') return normalized;
		if (normalized === 'predicate' || normalized === 'yesno' || normalized === 'yes_no' || normalized === 'boolean') {
			return 'noul';
		}
		throw new SystemOneError(
			`answers.${key}.type "${declared}" is not supported. Supported types are choice, noul, and score.`,
		);
	}
	if ('choice' in value || 'selected' in value) return 'choice';
	if ('noul' in value || 'yes' in value) return 'noul';
	if ('score' in value) return 'score';
	throw new SystemOneError(
		`answers.${key} has no type. Set type to "choice", "noul", or "score", or include the matching value field.`,
	);
}

function readChoice(
	value: Record<string, unknown>,
	probabilities: Record<string, number> | undefined,
	path: string,
): string {
	const explicit = firstDefined(value, ['choice', 'value', 'selected', 'label']);
	if (typeof explicit === 'string' && explicit !== '') return explicit;
	if (typeof explicit === 'number' && Number.isFinite(explicit)) return String(explicit);
	if (explicit !== undefined && explicit !== null) {
		throw new SystemOneError(`${path}.choice must be a non-empty string.`);
	}
	if (probabilities && Object.keys(probabilities).length > 0) {
		let winner = '';
		let winnerProbability = Number.NEGATIVE_INFINITY;
		for (const [label, probability] of Object.entries(probabilities)) {
			if (probability > winnerProbability) {
				winner = label;
				winnerProbability = probability;
			}
		}
		if (winner !== '') return winner;
	}
	throw new SystemOneError(`${path} is a choice answer with no choice value and no probabilities to derive one from.`);
}

function readProbabilityMap(value: unknown, path: string): Record<string, number> | undefined {
	if (value === undefined || value === null) return undefined;
	if (isPlainObject(value)) {
		const map: Record<string, number> = {};
		for (const [label, probability] of Object.entries(value)) {
			map[label] = readRequiredNumber(probability, `${path}.${label}`, false);
		}
		return map;
	}
	if (Array.isArray(value)) {
		const map: Record<string, number> = {};
		value.forEach((entry, index) => {
			if (!isPlainObject(entry)) {
				throw new SystemOneError(`${path}[${index}] must be an object with a label and a probability.`);
			}
			const label = firstString(entry, ['value', 'label', 'choice', 'name', 'key']);
			if (!label) {
				throw new SystemOneError(`${path}[${index}] is missing a value, label, or choice.`);
			}
			const probability = firstDefined(entry, ['probability', 'p', 'score']);
			map[label] = readRequiredNumber(probability, `${path}[${index}].probability`, false);
		});
		return map;
	}
	throw new SystemOneError(`${path} must be an object or an array of { "value", "probability" }.`);
}

function normalizeUsage(usage: unknown): UsageView | undefined {
	if (usage === undefined || usage === null) return undefined;
	if (!isPlainObject(usage)) {
		throw new SystemOneError(`usage must be an object of token counts. Received ${describeValue(usage)}.`);
	}
	const input = readOptionalNumber(
		firstDefined(usage, ['input_tokens', 'prompt_tokens', 'inputTokens', 'promptTokens']),
		'usage.input_tokens',
	);
	const output = readOptionalNumber(
		firstDefined(usage, ['output_tokens', 'completion_tokens', 'outputTokens', 'completionTokens']),
		'usage.output_tokens',
	);
	if (input === undefined && output === undefined) return undefined;
	return {
		...(input !== undefined ? { input_tokens: input } : {}),
		...(output !== undefined ? { output_tokens: output } : {}),
	};
}

function firstDefined(source: Record<string, unknown>, keys: string[]): unknown {
	for (const key of keys) {
		if (source[key] !== undefined && source[key] !== null) return source[key];
	}
	return undefined;
}

function firstString(source: Record<string, unknown>, keys: string[]): string | undefined {
	const value = firstDefined(source, keys);
	if (typeof value === 'string' && value !== '') return value;
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	return undefined;
}

function readOptionalNumber(value: unknown, path: string): number | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	return readRequiredNumber(value, path, false);
}

function readRequiredNumber(value: unknown, path: string, allowBoolean: boolean): number {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
	if (allowBoolean && typeof value === 'boolean') return value ? 1 : 0;
	throw new SystemOneError(`${path} must be a number. Received ${describeValue(value)}.`);
}
