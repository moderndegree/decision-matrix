import {
	assertFactsResolve,
	assertThresholdsResolve,
	decideFromFacts,
	decisionReceipt,
	evaluateRules,
	isPlainObject,
	questionsScriptsCannotOpen,
	validateRuleset,
	type AnswerView,
	type DecisionReceipt,
	type EvaluationResult,
	type FactMap,
	type Ruleset,
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
	/**
	 * Local scripts. Questions they answer are not sent to the server, except
	 * questions an opening rule reads when `open_gate_requires_facts` is set.
	 * The server answer wins on those.
	 */
	scripts?: unknown;
	thresholds?: Record<string, number>;
	/** Values the caller verified. Rules read them. They are not sent to the server. */
	facts?: FactMap;
	server?: DecideServer;
	failOnGate?: boolean;
}

export interface DecisionRecord extends EvaluationResult {
	answers: Record<string, AnswerView>;
	receipt: DecisionReceipt;
}

export interface DecideResult {
	record: DecisionRecord;
	exitCode: number;
}

/**
 * Check the ruleset, the facts, and any scripts, then evaluate saved answers,
 * local scripts, or the decision server. All of that is checked before the
 * server is contacted. When facts alone decide, the server is not called and
 * `answers` is empty. A question a script answers is left out of the request,
 * unless an opening rule reads it and the ruleset requires a fact to open.
 */
export async function decide(request: DecideRequest): Promise<DecideResult> {
	// Fail a bad ruleset, a missing fact, or a bad script before the server call.
	// evaluateRules reads the original document; the object returned here is the condition tree.
	const ruleset = validateRuleset(request.rules);
	assertThresholdsResolve(request.rules, request.thresholds);
	assertFactsResolve(request.rules, request.facts);
	const questions = validateQuestions(request.questions);
	if (request.answers !== undefined && request.scripts !== undefined) {
		throw new Error('Pass saved answers or scripts, not both.');
	}
	const program = request.scripts !== undefined ? validateScripts(request.scripts, questions) : undefined;
	const fromFacts = decideFromFacts(request.rules, request.facts, request.thresholds);
	if (fromFacts) return finish(ruleset, fromFacts, {}, request.failOnGate);
	const answers =
		request.answers !== undefined
			? readAnswers(request.answers)
			: await resolveAnswers(request.state, questions, program, request.server, ruleset);
	const decision = evaluateRules(request.rules, answers, request.thresholds, request.facts);
	return finish(ruleset, decision, answers, request.failOnGate);
}

function finish(
	ruleset: Ruleset,
	decision: EvaluationResult,
	answers: Record<string, AnswerView>,
	failOnGate: boolean | undefined,
): DecideResult {
	const record: DecisionRecord = { ...decision, answers, receipt: decisionReceipt(ruleset, decision) };
	return { record, exitCode: failOnGate && record.gate ? EXIT_GATE : EXIT_OK };
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
	ruleset: Ruleset,
): Promise<Record<string, AnswerView>> {
	const local = program ? runScripts(program, requireState(state)) : {};
	// Opening-rule questions still go to the server when a script cannot open the gate.
	// The server answer overwrites the script on the ids that were asked.
	const blocked = new Set(questionsScriptsCannotOpen(ruleset));
	const skip = Object.fromEntries(Object.entries(local).filter(([id]) => !blocked.has(id)));
	const remaining = unansweredQuestions(questions, skip);
	if (Object.keys(remaining).length === 0) return local;
	const remote = await askServer(state, remaining, server, program !== undefined);
	return { ...local, ...remote };
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
