export { describeValue, isPlainObject } from './object';
export { RulesError } from './errors';
export {
	assertFactsResolve,
	assertThresholdsResolve,
	bestEffortConfidence,
	decideFromFacts,
	evaluateRules,
	referencedFacts,
	referencedQuestions,
	referencedThresholds,
	renderTemplate,
	traceRules,
	validateRuleset,
	type EvaluationTrace,
	type FactMap,
	type RuleTrace,
	type ThresholdMap,
	type TraceCheck,
	type TraceNode,
} from './engine';
export { lintRuleset, type LintFinding, type LintOptions, type LintQuestion, type LintSeverity } from './lint';
export {
	ACCESS_REVIEW_RULES,
	ATTACK_TRIAGE_RULES,
	CI_CHANGE_RULES,
	GENERIC_TRIAGE_RULES,
	SDLC_RULES,
	SUPPORT_OPS_RULES,
} from './presets';
export type {
	ActionSpec,
	AnswerView,
	Condition,
	EvaluationResult,
	FactOperator,
	FactValue,
	Operator,
	Rule,
	Ruleset,
	ThresholdRef,
} from './types';
