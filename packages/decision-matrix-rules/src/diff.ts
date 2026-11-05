import { requiresFact, validateRuleset } from './engine';
import { implies } from './lint';
import type { Condition, FactOperator, Operator, Rule, Ruleset } from './types';

/**
 * What a change to a ruleset does to the policy, not which characters moved.
 *
 * The rule language is monotone: all, any, and every operator only get easier
 * or harder to satisfy together, and no condition is negated. So a condition
 * that matches more inputs makes a hold rule hold more (tightens) and an
 * allow rule allow more (loosens). Threshold changes are judged through the
 * rules that use them, with each version's thresholds.
 *
 * "review" means the condition changed and neither direction could be proven.
 */

export type ChangeEffect = 'loosens' | 'tightens' | 'review' | 'neutral';

export interface PolicyChange {
	effect: ChangeEffect;
	rule?: string;
	message: string;
}

export function diffRulesets(fromInput: unknown, toInput: unknown): PolicyChange[] {
	const from = validateRuleset(fromInput);
	const to = validateRuleset(toInput);
	const changes: PolicyChange[] = [];
	const add = (effect: ChangeEffect, message: string, rule?: string) => {
		changes.push(rule === undefined ? { effect, message } : { effect, rule, message });
	};

	if (from.open_gate_requires_facts && !to.open_gate_requires_facts) {
		add('loosens', 'open_gate_requires_facts was turned off. Model answers alone may now open the gate.');
	} else if (!from.open_gate_requires_facts && to.open_gate_requires_facts) {
		add('tightens', 'open_gate_requires_facts was turned on. Every rule that opens the gate now needs a fact.');
	}

	if ((from.owner ?? '') !== (to.owner ?? '')) add('neutral', `owner: ${from.owner ?? '(none)'} → ${to.owner ?? '(none)'}.`);
	if ((from.ticket ?? '') !== (to.ticket ?? '')) add('neutral', `ticket: ${from.ticket ?? '(none)'} → ${to.ticket ?? '(none)'}.`);
	if (JSON.stringify(from.fact_schema ?? null) !== JSON.stringify(to.fact_schema ?? null)) add('neutral', 'fact_schema changed.');
	diffAgreements(from, to, add);

	diffAction(from.default_action, to.default_action, 'default_action', undefined, add);

	for (const name of new Set([...Object.keys(from.thresholds), ...Object.keys(to.thresholds)])) {
		const before = from.thresholds[name];
		const after = to.thresholds[name];
		if (before === after) continue;
		if (before === undefined) add('neutral', `Threshold ${name} added: ${after}.`);
		else if (after === undefined) add('neutral', `Threshold ${name} removed (was ${before}).`);
		else add('neutral', `Threshold ${name}: ${before} → ${after}. Its effect is listed under each rule that uses it.`);
	}

	const fromRules = new Map(from.rules.map((rule) => [rule.id, rule]));
	const toRules = new Map(to.rules.map((rule) => [rule.id, rule]));

	for (const rule of from.rules) {
		if (toRules.has(rule.id)) continue;
		if (rule.action.gate) add('loosens', `Removed "${rule.id}", which held (${rule.action.type}).`, rule.id);
		else add('tightens', `Removed "${rule.id}", which opened the gate (${rule.action.type}).`, rule.id);
	}
	for (const rule of to.rules) {
		if (fromRules.has(rule.id)) continue;
		if (rule.action.gate) {
			add('tightens', `Added "${rule.id}", which holds (${rule.action.type}).`, rule.id);
		} else {
			const alone = requiresFact(rule.when) ? '' : ' Model answers alone can satisfy it.';
			add('loosens', `Added "${rule.id}", which opens the gate (${rule.action.type}).${alone}`, rule.id);
		}
	}

	for (const after of to.rules) {
		const before = fromRules.get(after.id);
		if (!before) continue;
		diffAction(before.action, after.action, `"${after.id}"`, after.id, add);
		diffCondition(before, after, from, to, add);
	}

	diffOrder(from, to, add);
	return changes;
}

/** Adding an agreement can only add holds. Removing one takes a hold away. */
function diffAgreements(
	from: Ruleset,
	to: Ruleset,
	add: (effect: ChangeEffect, message: string, rule?: string) => void,
): void {
	const key = (agreement: { question: string; fact: string; relation: string }) =>
		`${agreement.question}\0${agreement.fact}\0${agreement.relation}`;
	const before = new Set((from.agreements ?? []).map(key));
	const after = new Set((to.agreements ?? []).map(key));
	for (const agreement of to.agreements ?? []) {
		if (before.has(key(agreement))) continue;
		add('tightens', `Added an agreement: question "${agreement.question}" ${agreement.relation} fact "${agreement.fact}". A disagreement can now force a hold.`);
	}
	for (const agreement of from.agreements ?? []) {
		if (after.has(key(agreement))) continue;
		add('loosens', `Removed an agreement: question "${agreement.question}" ${agreement.relation} fact "${agreement.fact}". That disagreement no longer forces a hold.`);
	}
}

function diffAction(
	before: Rule['action'],
	after: Rule['action'],
	label: string,
	rule: string | undefined,
	add: (effect: ChangeEffect, message: string, rule?: string) => void,
): void {
	if (before.gate && !after.gate) add('loosens', `${label} now opens the gate (gate true → false).`, rule);
	if (!before.gate && after.gate) add('tightens', `${label} now holds (gate false → true).`, rule);
	if (before.type !== after.type) add('neutral', `${label} action type: ${before.type} → ${after.type}.`, rule);
	if (before.target !== after.target) add('neutral', `${label} target: ${before.target} → ${after.target}.`, rule);
	if (before.reason !== after.reason) add('neutral', `${label} reason changed.`, rule);
}

function diffCondition(
	before: Rule,
	after: Rule,
	from: Ruleset,
	to: Ruleset,
	add: (effect: ChangeEffect, message: string, rule?: string) => void,
): void {
	const oldResolved = JSON.stringify(resolved(before.when, from.thresholds));
	const newResolved = JSON.stringify(resolved(after.when, to.thresholds));
	if (oldResolved === newResolved) return;

	const sameShape = JSON.stringify(before.when) === JSON.stringify(after.when);
	const cause = sameShape ? 'after a threshold change' : 'after its condition changed';
	const broader = implies(before.when, after.when, from.thresholds, to.thresholds);
	const narrower = implies(after.when, before.when, to.thresholds, from.thresholds);
	const holds = after.action.gate;
	const id = after.id;
	if (broader && narrower) {
		add('neutral', `"${id}" condition was rewritten with the same meaning.`, id);
	} else if (broader) {
		add(holds ? 'tightens' : 'loosens', `"${id}" matches more events ${cause}, so it ${holds ? 'holds' : 'opens the gate'} more often.`, id);
	} else if (narrower) {
		add(holds ? 'loosens' : 'tightens', `"${id}" matches fewer events ${cause}, so it ${holds ? 'holds' : 'opens the gate'} less often.`, id);
	} else {
		add('review', `"${id}" matches a different set of events ${cause}. Whether it ${holds ? 'holds' : 'opens the gate'} more or less often could not be determined.`, id);
	}
}

/** A gate-opening rule that moves ahead of a holding rule can now win where the hold used to. */
function diffOrder(from: Ruleset, to: Ruleset, add: (effect: ChangeEffect, message: string, rule?: string) => void): void {
	const oldIndex = new Map(from.rules.map((rule, index) => [rule.id, index]));
	const kept = to.rules.filter((rule) => oldIndex.has(rule.id));
	for (let i = 0; i < kept.length; i++) {
		for (let j = i + 1; j < kept.length; j++) {
			const first = kept[i]!;
			const second = kept[j]!;
			if (oldIndex.get(first.id)! < oldIndex.get(second.id)!) continue;
			// first now comes before second, and it did not before.
			if (!first.action.gate && second.action.gate) {
				add('loosens', `"${first.id}" (opens the gate) now comes before "${second.id}" (holds). Where both match, it now wins.`, first.id);
			} else if (first.action.gate && !second.action.gate) {
				add('tightens', `"${first.id}" (holds) now comes before "${second.id}" (opens the gate). Where both match, the hold now wins.`, first.id);
			} else {
				add('neutral', `"${first.id}" now comes before "${second.id}".`, first.id);
			}
		}
	}
}

/** The condition with every threshold name replaced by its number, for comparison. */
function resolved(condition: Condition, thresholds: Record<string, number>): unknown {
	if (condition.kind === 'all' || condition.kind === 'any') {
		return { [condition.kind]: condition.conditions.map((child) => resolved(child, thresholds)) };
	}
	const subject = condition.kind === 'fact' ? { fact: condition.fact } : { question: condition.question };
	const operators = (condition.operators as Array<Operator | FactOperator>).map((operator) => {
		if ('values' in operator) return [operator.op, operator.values];
		const value = operator.value;
		if (value !== null && typeof value === 'object') {
			if (value.kind === 'number') return [operator.op, value.value];
			if (value.kind === 'instant') return [operator.op, value.ms];
			return [operator.op, thresholds[value.name]];
		}
		return [operator.op, value];
	});
	return { ...subject, operators };
}
