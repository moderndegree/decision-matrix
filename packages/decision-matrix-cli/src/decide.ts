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
	runScripts,
	unansweredQuestions,
	validateQuestions,
	validateScripts,
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
	/** Saved System One response, or a bare answers map. Skips the server and any scripts. */
	answers?: unknown;
	/** Local scripts. Questions they answer are not sent to the server. */
	scripts?: unknown;
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
 * Check the ruleset, the facts, and any scripts, then evaluate saved answers,
 * local scripts, or the decision server. All of that is checked before the
 * server is contacted. When facts alone decide, the server is not called and
 * `answers` is empty. A question a script answers is left out of the request.
 */
export async function decide(request: DecideRequest): Promise<DecideResult> {
	// Fail a bad ruleset, a missing fact, or a bad script before the server call.
	// evaluateRules reads the original document; the object returned here is the condition tree.
	assertThresholdsResolve(request.rules, request.thresholds);
	assertFactsResolve(request.rules, request.facts);
	const questions = validateQuestions(request.questions);
	if (request.answers !== undefined && request.scripts !== undefined) {
		throw new Error('Pass saved answers or scripts, not both.');
	}
	const program = request.scripts !== undefined ? validateScripts(request.scripts, questions) : undefined;
	const fromFacts = decideFromFacts(request.rules, request.facts, request.thresholds);
	if (fromFacts) {
		const record: DecisionRecord = { ...fromFacts, answers: {} };
		return { record, exitCode: request.failOnGate && record.gate ? EXIT_GATE : EXIT_OK };
	}
	const answers =
		request.answers !== undefined
			? readAnswers(request.answers)
			: await resolveAnswers(request.state, questions, program, request.server);
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

async function resolveAnswers(
	state: unknown,
	questions: Record<string, unknown>,
	program: ReturnType<typeof validateScripts> | undefined,
	server: DecideServer | undefined,
): Promise<Record<string, AnswerView>> {
	const local = program ? runScripts(program, requireState(state)) : {};
	const remaining = unansweredQuestions(questions, local);
	if (Object.keys(remaining).length === 0) return local;
	const remote = await askServer(state, remaining, server, program !== undefined);
	return { ...remote, ...local };
}

async function askServer(
	state: unknown,
	questions: Record<string, unknown>,
	server: DecideServer | undefined,
	scriptsRan: boolean,
): Promise<Record<string, AnswerView>> {
	if (server === undefined || server.baseUrl.trim() === '') {
		const unanswered = Object.keys(questions);
		throw new Error(
			scriptsRan
				? `A decision server URL is required. Scripts did not answer: ${unanswered.join(', ')}. Pass --server for those, or add a step that answers them.`
				: 'A decision server URL is required. Pass --server or set DECISION_SERVER_URL. Pass --answers to evaluate a saved answer file, or --local or --scripts to answer with scripts instead of a model.',
		);
	}
	requireState(state);
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

function requireState(state: unknown): unknown {
	if (state === undefined || (typeof state === 'string' && state.trim() === '')) {
		throw new Error('State is required. Pass --state or pipe the event on stdin.');
	}
	return state;
}

function looksLikeEnvelope(value: Record<string, unknown>): boolean {
	if (value.answers !== undefined) return true;
	for (const key of ['data', 'result'] as const) {
		const nested = value[key];
		if (isPlainObject(nested) && nested.answers !== undefined) return true;
	}
	return false;
}
