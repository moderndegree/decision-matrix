import {
	ACCESS_REVIEW_RULES,
	ATTACK_TRIAGE_RULES,
	CI_CHANGE_RULES,
	GENERIC_TRIAGE_RULES,
	SDLC_RULES,
	SUPPORT_OPS_RULES,
} from 'decision-matrix-rules';
import {
	ACCESS_REVIEW_QUESTIONS,
	ATTACK_TRIAGE_QUESTIONS,
	CI_CHANGE_QUESTIONS,
	GENERIC_TRIAGE_QUESTIONS,
	SDLC_QUESTIONS,
	SUPPORT_OPS_QUESTIONS,
} from 'decision-matrix-systemone';

export interface PolicyPreset {
	questions: Record<string, unknown>;
	rules: unknown;
}

/** Built-in question set and ruleset pairs. Callers pass them explicitly. */
export const POLICY_PRESETS: Record<string, PolicyPreset> = {
	'attack-triage': { questions: ATTACK_TRIAGE_QUESTIONS, rules: ATTACK_TRIAGE_RULES },
	generic: { questions: GENERIC_TRIAGE_QUESTIONS, rules: GENERIC_TRIAGE_RULES },
	sdlc: { questions: SDLC_QUESTIONS, rules: SDLC_RULES },
	support: { questions: SUPPORT_OPS_QUESTIONS, rules: SUPPORT_OPS_RULES },
	'ci-change': { questions: CI_CHANGE_QUESTIONS, rules: CI_CHANGE_RULES },
	'access-review': { questions: ACCESS_REVIEW_QUESTIONS, rules: ACCESS_REVIEW_RULES },
};

export const DEFAULT_PRESET = 'attack-triage';
