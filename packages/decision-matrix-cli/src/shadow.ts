import { createHash } from 'node:crypto';

import { validateRuleset } from 'decision-matrix-rules';

import { decideCase, type CaseProvenance, type PolicyCase } from './cases';

/**
 * Replays a candidate ruleset on saved cases. It prints both actions and
 * never writes a cutoff or an action back into the ruleset.
 */

export type ShadowKind = 'hold-to-open' | 'open-to-hold' | 'unchanged';

export interface ShadowRow {
	name: string;
	kind: ShadowKind;
	before: string;
	after: string;
}

const RANK: Record<ShadowKind, number> = { 'hold-to-open': 0, 'open-to-hold': 1, unchanged: 2 };

export function shadowCases(from: unknown, to: unknown, cases: PolicyCase[]): ShadowRow[] {
	const rows = cases.map((testCase, index) => {
		const before = decideCase(from, testCase);
		const after = decideCase(to, testCase);
		const beforeGate = before.decision?.gate;
		const afterGate = after.decision?.gate;
		const kind: ShadowKind =
			beforeGate === true && afterGate === false ? 'hold-to-open' : beforeGate === false && afterGate === true ? 'open-to-hold' : 'unchanged';
		return { index, name: testCase.name, kind, before: describe(before), after: describe(after) };
	});
	rows.sort((left, right) => RANK[left.kind] - RANK[right.kind] || left.index - right.index);
	return rows.map(({ name, kind, before, after }) => ({ name, kind, before, after }));
}

export function formatShadow(rows: ShadowRow[], fromLabel: string, toLabel: string): string {
	const lines = [`shadow: ${fromLabel} → ${toLabel}`, ''];
	const groups: Array<[ShadowKind, string]> = [
		['hold-to-open', 'hold→open'],
		['open-to-hold', 'open→hold'],
		['unchanged', 'unchanged'],
	];
	for (const [kind, label] of groups) {
		const group = rows.filter((row) => row.kind === kind);
		lines.push(`${label}  ${group.length}`);
		for (const row of group) {
			lines.push(`  ${row.name}`);
			lines.push(`    ${row.before} → ${row.after}`);
		}
	}
	return `${lines.join('\n')}\n`;
}

export interface SweepLine {
	threshold: string;
	cutoff: number;
	baseline: boolean;
	holdToOpen: number;
	openToHold: number;
	unchanged: number;
}

/** Cutoffs from 0.50 through 0.95, plus the baseline when it is not already on that grid. */
export function sweepThresholds(rules: unknown, cases: PolicyCase[]): SweepLine[] {
	const ruleset = validateRuleset(rules);
	const lines: SweepLine[] = [];
	for (const [name, baseline] of Object.entries(ruleset.thresholds)) {
		if (!(baseline >= 0 && baseline <= 1)) continue;
		const points = grid();
		if (!points.some((point) => close(point, baseline))) points.push(baseline);
		points.sort((left, right) => left - right);
		for (const cutoff of points) {
			if (close(cutoff, baseline)) {
				lines.push({ threshold: name, cutoff: baseline, baseline: true, holdToOpen: 0, openToHold: 0, unchanged: cases.length });
				continue;
			}
			let holdToOpen = 0;
			let openToHold = 0;
			let unchanged = 0;
			for (const testCase of cases) {
				const before = decideCase(rules, testCase).decision?.gate;
				const after = decideCase(rules, testCase, { [name]: cutoff }).decision?.gate;
				if (before === true && after === false) holdToOpen += 1;
				else if (before === false && after === true) openToHold += 1;
				else unchanged += 1;
			}
			lines.push({ threshold: name, cutoff, baseline: false, holdToOpen, openToHold, unchanged });
		}
	}
	return lines;
}

export function formatSweep(lines: SweepLine[], provenance: CaseProvenance | undefined, questionsNote?: string): string {
	const out: string[] = [];
	if (!provenance) out.push('Not a calibration. Cases have no provenance (model_id, temperature, questions_hash).');
	if (questionsNote) out.push(questionsNote);
	if (lines.length === 0) out.push('No threshold with a baseline from 0 to 1.');
	let current = '';
	for (const line of lines) {
		if (line.threshold !== current) {
			current = line.threshold;
			out.push(`threshold ${current}`);
		}
		const label = line.cutoff.toFixed(2);
		out.push(
			line.baseline
				? `  ${label}  (baseline)`
				: `  ${label}  hold→open ${line.holdToOpen}  open→hold ${line.openToHold}  unchanged ${line.unchanged}`,
		);
	}
	return `${out.join('\n')}\n`;
}

/** sha256 of the questions file's UTF-8 bytes, not of a re-serialized JSON value. */
export function questionsFileHash(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

export function formatQuestionsNote(fileHash: string, recorded: string | undefined): string {
	if (!recorded) return `Questions file sha256 ${fileHash}. Cases have no questions_hash.`;
	if (fileHash === recorded) return `Questions file sha256 matches the cases (${fileHash}).`;
	return `Questions file sha256 ${fileHash} does not match cases questions_hash ${recorded}.`;
}

function describe(result: ReturnType<typeof decideCase>): string {
	if (result.error !== undefined) return `error: ${result.error}`;
	const decision = result.decision!;
	return `${decision.action} (${decision.matched_rule ?? 'default'}, gate ${decision.gate})`;
}

function grid(): number[] {
	const points: number[] = [];
	for (let step = 0; step <= 9; step += 1) points.push(Math.round((0.5 + step * 0.05) * 100) / 100);
	return points;
}

function close(left: number, right: number): boolean {
	return Math.abs(left - right) < 1e-9;
}
