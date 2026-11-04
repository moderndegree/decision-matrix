import {
	assertFactsResolve,
	assertThresholdsResolve,
	decideFromFacts,
	evaluateRules,
	isPlainObject,
	type AnswerView,
	type FactMap,
} from 'decision-matrix-rules';
import {
	callSystemOne,
	normalizeSystemOneResponse,
	readState,
	validateQuestions,
	type SystemOneCallOptions,
} from 'decision-matrix-systemone';

/** Fields the command knows about. `state` and `questions` are supplied by decide(). */
export interface DecideServer {
	baseUrl: string;
	apiKey?: string;
	model?: string;
	timeoutMs?: number;
	fetch?: SystemOneCallOptions['fetch'];
}

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
/** Printed a decision whose gate is true. Used only with --fail-on-gate. */
export const EXIT_GATE = 2;

export interface DecideRequest {
	/** Event text, object, or array. Required when `answers` is omitted. */
	state?: unknown;
	questions: unknown;
	rules: unknown;
	/** Saved System One response, or a bare answers map. Skips the server. */
	answers?: unknown;
	thresholds?: Record<string, number>;
	/** Values the caller verified. Rules read them. They are not sent to the server. */
	facts?: FactMap;
	server?: DecideServer;
	failOnGate?: boolean;
}

export interface DecisionRecord {
	action: string;
	target: string;
	reason: string;
	gate: boolean;
	matched_rule: string | null;
	confidence: number;
	answers: Record<string, AnswerView>;
}

export interface DecideResult {
	record: DecisionRecord;
	exitCode: number;
}

/**
 * Check the ruleset and the facts, then either evaluate saved answers or call
 * the decision server. Both are checked before the server is contacted. When
 * facts alone decide, the server is not called and `answers` is empty.
 */
export async function decide(request: DecideRequest): Promise<DecideResult> {
	// Fail a bad ruleset or a missing fact before the server call. evaluateRules
	// reads the original document; the object returned here is the condition tree.
	assertThresholdsResolve(request.rules, request.thresholds);
	assertFactsResolve(request.rules, request.facts);
	const questions = validateQuestions(request.questions);
	const fromFacts = decideFromFacts(request.rules, request.facts, request.thresholds);
	if (fromFacts) {
		const record: DecisionRecord = { ...fromFacts, answers: {} };
		return { record, exitCode: request.failOnGate && record.gate ? EXIT_GATE : EXIT_OK };
	}
	const answers =
		request.answers !== undefined
			? readAnswers(request.answers)
			: await askServer(request.state, questions, request.server);
	const decision = evaluateRules(request.rules, answers, request.thresholds, request.facts);
	const record: DecisionRecord = { ...decision, answers };
	const exitCode = request.failOnGate && record.gate ? EXIT_GATE : EXIT_OK;
	return { record, exitCode };
}

/** Accepts a System One body or a map of answers keyed by question id. */
export function readAnswers(value: unknown): Record<string, AnswerView> {
	const envelope = isPlainObject(value) && !looksLikeEnvelope(value) ? { answers: value } : value;
	return normalizeSystemOneResponse(envelope).answers;
}

async function askServer(
	state: unknown,
	questions: Record<string, unknown>,
	server: DecideServer | undefined,
): Promise<Record<string, AnswerView>> {
	if (server === undefined || server.baseUrl.trim() === '') {
		throw new Error(
			'A decision server URL is required. Pass --server or set DECISION_SERVER_URL. Pass --answers to evaluate a saved answer file instead.',
		);
	}
	if (state === undefined || (typeof state === 'string' && state.trim() === '')) {
		throw new Error('State is required. Pass --state or pipe the event on stdin.');
	}
	const result = await callSystemOne({
		baseUrl: server.baseUrl,
		apiKey: server.apiKey,
		model: server.model,
		timeoutMs: server.timeoutMs,
		fetch: server.fetch,
		state: readState(state),
		questions,
	});
	return result.answers;
}

function looksLikeEnvelope(value: Record<string, unknown>): boolean {
	if (value.answers !== undefined) return true;
	for (const key of ['data', 'result'] as const) {
		const nested = value[key];
		if (isPlainObject(nested) && nested.answers !== undefined) return true;
	}
	return false;
}
