/**
 * View of one System One answer that the rules engine knows how to read.
 * The HTTP layer normalizes vendor-specific payloads into this shape.
 */
export interface AnswerView {
	type: 'choice' | 'noul' | 'score';
	choice?: string;
	noul?: number;
	score?: number;
	confidence?: number;
	probabilities?: Record<string, number>;
}

export interface ActionSpec {
	type: string;
	target: string;
	reason: string;
	gate: boolean;
}

/** A number, or a name resolved later against thresholds + overrides. */
export type ThresholdRef = { kind: 'number'; value: number } | { kind: 'threshold'; name: string };

/**
 * A fact ordered-compare. Instants are epoch milliseconds from an ISO-8601
 * timestamp. They are not ordered as strings.
 */
export type OrderedValue = ThresholdRef | { kind: 'instant'; ms: number };

/** What a fact schema entry says the host will supply. */
export type FactSchemaType = 'string' | 'number' | 'boolean' | 'null' | 'instant' | 'array';

export interface FactSchemaEntry {
	type: FactSchemaType;
	/** The host must supply this on every event. A missing value is still an error when a rule reads it, even when this is false. */
	required: boolean;
}

/**
 * A declared correspondence between one model answer and one fact.
 * When the decision would open the gate and the two disagree, the result
 * becomes a hold. This never opens a gate.
 */
export interface Agreement {
	question: string;
	fact: string;
	/** `eq` means the answer should restate the fact. `inverse` means it should contradict the fact. */
	relation: 'eq' | 'inverse';
}

/** One question's margin. A margin is not an authorization. */
export interface QuestionContribution {
	question: string;
	/** Best-effort confidence, or noul decisiveness `abs(p - 0.5) * 2`. */
	margin: number;
	/** True when this question sits on a branch that was true for the winning rule. */
	satisfied: boolean;
}

export type Operator =
	| { op: 'eq' | 'neq'; value: string }
	| { op: 'in' | 'not_in'; values: string[] }
	| {
			op: 'gte' | 'gt' | 'lte' | 'lt' | 'confidence_gte' | 'confidence_lt';
			value: ThresholdRef;
	  };

/** A scalar a host verified itself. Fact predicates compare these strictly. */
export type FactValue = string | number | boolean | null;

export type FactOperator =
	| { op: 'eq' | 'neq'; value: FactValue }
	| { op: 'in' | 'not_in'; values: FactValue[] }
	| { op: 'contains' | 'not_contains'; value: FactValue }
	| { op: 'gte' | 'gt' | 'lte' | 'lt'; value: OrderedValue };

export type Condition =
	| { kind: 'all'; conditions: Condition[] }
	| { kind: 'any'; conditions: Condition[] }
	| { kind: 'predicate'; question: string; operators: Operator[] }
	| { kind: 'fact'; fact: string; path: string[]; operators: FactOperator[] };

export interface Rule {
	id: string;
	description?: string;
	when: Condition;
	action: ActionSpec;
}

export interface Ruleset {
	version: 1;
	default_action: ActionSpec;
	thresholds: Record<string, number>;
	rules: Rule[];
	/**
	 * When true, the default action must hold (gate true) and every rule that
	 * opens the gate must require a fact on every path through its `when`.
	 * A model answer alone can then never open the gate.
	 */
	open_gate_requires_facts?: boolean;
	/** Who owns this policy, for a reviewer. CI can reject an empty field. */
	owner?: string;
	/** Ticket or change id that introduced the policy. CI can reject an empty field. */
	ticket?: string;
	/** Declared types for fact paths. Missing and wrong-typed values stay errors. */
	fact_schema?: Record<string, FactSchemaEntry>;
	/** Model/fact pairs that force a hold when they disagree and the decision would open. */
	agreements?: Agreement[];
}

export interface EvaluationResult {
	action: string;
	target: string;
	reason: string;
	gate: boolean;
	matched_rule: string | null;
	/**
	 * Minimum margin of the questions the winning rule references.
	 * This is a diagnostic. It does not open the gate.
	 */
	confidence: number;
	/** The same number as `confidence`, named as a margin so callers do not treat it as a calibrated probability. */
	margin: number;
	/** Per-question margins for the winning rule. Empty when the default action applied or the rule reads only facts. */
	contributions: QuestionContribution[];
}
