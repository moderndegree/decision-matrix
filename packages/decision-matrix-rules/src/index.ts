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
	validateFacts,
	validateRuleset,
	type EvaluationTrace,
	type FactMap,
	type RuleTrace,
	type ThresholdMap,
	type TraceCheck,
	type TraceNode,
} from './engine';
export { diffRulesets, type ChangeEffect, type PolicyChange } from './diff';
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
