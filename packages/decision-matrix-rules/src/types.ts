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
	| { op: 'gte' | 'gt' | 'lte' | 'lt'; value: ThresholdRef };

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
}

export interface EvaluationResult {
	action: string;
	target: string;
	reason: string;
	gate: boolean;
	matched_rule: string | null;
	confidence: number;
}
