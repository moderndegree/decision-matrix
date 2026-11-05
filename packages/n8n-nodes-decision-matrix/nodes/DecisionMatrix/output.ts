import { decisionReceipt, type EvaluationResult, type Ruleset } from 'decision-matrix-rules';
import type { SystemOneResult } from 'decision-matrix-systemone';

export interface OutputFlags {
	includeFullAnswers: boolean;
	includeRawResponse: boolean;
}

/**
 * Item JSON returned by the node. Routing fields are always present.
 * `answers` and `raw_response` follow the node options. `usage` is included
 * only when the server reported token counts.
 */
export function buildItemOutput(
	evaluation: EvaluationResult,
	systemOne: SystemOneResult,
	rawBody: unknown,
	flags: OutputFlags,
	ruleset: Ruleset,
): Record<string, unknown> {
	const output: Record<string, unknown> = {
		action: evaluation.action,
		target: evaluation.target,
		reason: evaluation.reason,
		gate: evaluation.gate,
		matched_rule: evaluation.matched_rule,
		confidence: evaluation.confidence,
		margin: evaluation.margin,
		contributions: evaluation.contributions,
		receipt: decisionReceipt(ruleset, evaluation),
	};
	if (flags.includeFullAnswers) output.answers = systemOne.rawAnswers;
	if (flags.includeRawResponse) output.raw_response = rawBody;
	if (systemOne.usage) output.usage = systemOne.usage;
	return output;
}

export function noMatchMessage(evaluation: EvaluationResult): string {
	return `No rule matched. Fail on no matching rule is enabled, so the default action was not returned. That default would have been action "${evaluation.action}", target "${evaluation.target}", reason "${evaluation.reason}".`;
}
