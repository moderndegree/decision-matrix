import { diffRulesets, type ChangeEffect, type PolicyChange } from 'decision-matrix-rules';

import { decideCase, type CaseDecision, type PolicyCase } from './cases';

/**
 * A policy diff for people: what each change does, and which test cases now
 * get a different decision. Meant for a PR comment or a step summary.
 */

export interface CaseChange {
	name: string;
	before: CaseDecision;
	after: CaseDecision;
	/** The case held before and now opens the gate. */
	opens: boolean;
}

export interface PolicyDiff {
	changes: PolicyChange[];
	cases: CaseChange[];
	casesCompared: number;
	/** True when anything loosens, cannot be judged, or a case newly opens the gate. */
	loosens: boolean;
}

export function diffPolicies(from: unknown, to: unknown, cases: PolicyCase[] = []): PolicyDiff {
	const changes = diffRulesets(from, to);
	const changed: CaseChange[] = [];
	for (const testCase of cases) {
		const before = decideCase(from, testCase);
		const after = decideCase(to, testCase);
		if (summary(before) === summary(after)) continue;
		const opens = before.decision?.gate !== false && after.decision?.gate === false;
		changed.push({ name: testCase.name, before, after, opens });
	}
	const loosens =
		changes.some((change) => change.effect === 'loosens' || change.effect === 'review') || changed.some((change) => change.opens);
	return { changes, cases: changed, casesCompared: cases.length, loosens };
}

function summary(result: CaseDecision): string {
	if (result.error !== undefined) return `error: ${result.error}`;
	const decision = result.decision!;
	return `${decision.action} (${decision.matched_rule ?? 'default'}, gate ${decision.gate})`;
}

const SECTIONS: Array<[ChangeEffect, string]> = [
	['loosens', 'Loosens'],
	['review', 'Needs review: direction unknown'],
	['tightens', 'Tightens'],
	['neutral', 'Other changes'],
];

export function formatPolicyDiff(diff: PolicyDiff, fromLabel: string, toLabel: string, markdown: boolean): string {
	const lines: string[] = [];
	const heading = (text: string) => lines.push(markdown ? `### ${text}` : text);
	const item = (text: string) => lines.push(markdown ? `- ${text}` : `  - ${text}`);
	lines.push(markdown ? `## Policy diff: \`${fromLabel}\` → \`${toLabel}\`` : `Policy diff: ${fromLabel} → ${toLabel}`);
	lines.push('');
	if (diff.changes.length === 0) lines.push('No policy changes.', '');
	for (const [effect, title] of SECTIONS) {
		const entries = diff.changes.filter((change) => change.effect === effect);
		if (entries.length === 0) continue;
		heading(`${title} (${entries.length})`);
		for (const change of entries) item(change.message);
		lines.push('');
	}
	if (diff.casesCompared > 0) {
		heading(`Cases whose decision changes (${diff.cases.length} of ${diff.casesCompared})`);
		for (const change of diff.cases) {
			const warn = change.opens ? (markdown ? ' **now opens the gate**' : '  [now opens the gate]') : '';
			item(`${change.name}: ${summary(change.before)} → ${summary(change.after)}${warn}`);
		}
		if (diff.cases.length === 0) item('none');
		lines.push('');
	}
	return `${lines.join('\n').trimEnd()}\n`;
}
