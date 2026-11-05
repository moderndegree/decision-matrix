import type { Condition, LintFinding, Rule, TraceNode } from 'decision-matrix-rules';
import { flatWhen, referencedQuestions } from 'decision-matrix-rules';
import type { CaseResult } from 'decision-matrix-cli';

import type { CaseValue } from './model';

export const COLORS = {
	text: '#c0caf5',
	dim: '#737aa2',
	accent: '#7aa2f7',
	hold: '#f7768e',
	open: '#9ece6a',
	warn: '#e0af68',
	focus: '#7dcfff',
	border: '#3b4261',
	selected: '#283457',
} as const;

export type Tone = 'text' | 'dim' | 'accent' | 'hold' | 'open' | 'warn';

export interface Line {
	text: string;
	tone?: Tone;
	selected?: boolean;
}

/** The slice of a list to show so the selection stays visible. */
export function visibleWindow(count: number, selected: number, rows: number): [number, number] {
	if (rows <= 0) return [0, 0];
	if (count <= rows) return [0, count];
	const start = Math.min(Math.max(0, selected - Math.floor(rows / 2)), count - rows);
	return [start, start + rows];
}

export function Pane(props: { title: string; focused: boolean; width: number | `${number}%`; height: number; lines: Line[]; selectedIndex?: number }) {
	const rows = Math.max(0, props.height - 2);
	const [start, end] = props.selectedIndex === undefined ? [0, Math.min(rows, props.lines.length)] : visibleWindow(props.lines.length, props.selectedIndex, rows);
	const shown = props.lines.slice(start, end);
	return (
		<box
			title={props.title}
			style={{
				border: true,
				borderColor: props.focused ? COLORS.focus : COLORS.border,
				width: props.width,
				height: props.height,
				flexDirection: 'column',
				paddingLeft: 1,
				paddingRight: 1,
			}}
		>
			{shown.map((line, index) => (
				<text
					key={start + index}
					wrapMode="none"
					truncate
					fg={COLORS[line.tone ?? 'text']}
					bg={line.selected ? COLORS.selected : undefined}
				>
					{line.text}
				</text>
			))}
		</box>
	);
}

// --- Line builders ----------------------------------------------------------

export function ruleLines(rules: Rule[], defaultAction: Rule['action'], findings: LintFinding[], covered: Map<string | null, number>, selected: number, hasCases: boolean): Line[] {
	const width = String(rules.length).length;
	const lines: Line[] = rules.map((rule, index) => {
		const facts = referencedQuestions(rule.when).length === 0 ? ' facts' : '';
		const warn = findings.some((finding) => finding.rule === rule.id && finding.severity !== 'info') ? ' ⚠' : '';
		const count = hasCases ? ` ${covered.get(rule.id) ?? 0}✓` : '';
		return {
			text: `${String(index + 1).padStart(width)} ${rule.action.gate ? '●' : '○'} ${rule.id}${facts}${warn}${count}`,
			tone: warn ? 'warn' : rule.action.gate ? 'text' : 'open',
			selected: index === selected,
		};
	});
	lines.push({
		text: `${' '.repeat(width)} ${defaultAction.gate ? '●' : '○'} default → ${defaultAction.type} · ${defaultAction.target} · footer${hasCases ? ` ${covered.get(null) ?? 0}✓` : ''}`,
		tone: defaultAction.gate ? 'dim' : 'warn',
		selected: selected === rules.length,
	});
	return lines;
}

/** The detail pane for the default action, the one that applies when no rule matches. */
export function defaultLines(action: Rule['action'], findings: LintFinding[], strict: boolean): Line[] {
	const lines: Line[] = [
		{ text: 'Footer. Applies when no rule matches. It cannot be moved.', tone: 'dim' },
		{ text: `→ ${action.type} · ${action.target} · ${action.gate ? 'holds' : 'opens the gate'}`, tone: action.gate ? 'hold' : 'open' },
		{ text: `  ${action.reason}`, tone: 'dim' },
		{ text: '' },
		{
			text: strict ? 'Strict: open_gate_requires_facts is on, so this must hold.' : 'Not strict: model answers alone may open the gate. Shift+S turns strict on.',
			tone: strict ? 'open' : 'warn',
		},
	];
	for (const finding of findings.filter((entry) => entry.code === 'default-opens-gate')) lines.push({ text: `${finding.severity}: ${finding.message}`, tone: 'warn' });
	lines.push({ text: '' }, { text: 'e edit · g toggle the gate', tone: 'dim' });
	return lines;
}

export function detailLines(rule: Rule | undefined, thresholds: Record<string, number>, trace: TraceNode | undefined, traceError: string | undefined, findings: LintFinding[], caseName: string | undefined): Line[] {
	if (!rule) return [{ text: 'No rules. Press n to add one.', tone: 'dim' }];
	const lines: Line[] = [];
	if (rule.description) lines.push({ text: rule.description, tone: 'dim' });
	lines.push({
		text: `→ ${rule.action.type} · ${rule.action.target} · ${rule.action.gate ? 'holds' : 'opens the gate'}`,
		tone: rule.action.gate ? 'hold' : 'open',
	});
	lines.push({ text: `  ${rule.action.reason}`, tone: 'dim' });
	lines.push({ text: caseName ? `when   (checked against "${caseName}")` : 'when', tone: 'accent' });
	const flat = flatWhen(rule.when);
	if (flat) lines.push({ text: `  ${flat}`, tone: 'dim' });
	if (traceError) lines.push({ text: `  could not evaluate: ${traceError}`, tone: 'warn' });
	conditionLines(rule.when, trace, thresholds, 1, lines);
	for (const finding of findings.filter((entry) => entry.rule === rule.id)) {
		lines.push({ text: `${finding.severity}: ${finding.message}`, tone: finding.severity === 'info' ? 'dim' : 'warn' });
	}
	return lines;
}

function conditionLines(condition: Condition, trace: TraceNode | undefined, thresholds: Record<string, number>, depth: number, into: Line[]): void {
	const pad = '  '.repeat(depth);
	const mark = trace ? (trace.matched ? '✓ ' : '✗ ') : '';
	const tone: Tone | undefined = trace ? (trace.matched ? 'open' : 'dim') : undefined;
	if (condition.kind === 'all' || condition.kind === 'any') {
		into.push({ text: `${pad}${mark}${condition.kind === 'all' ? 'all of' : 'any of'}`, ...(tone ? { tone } : {}) });
		condition.conditions.forEach((child, index) => {
			const childTrace = trace && (trace.kind === 'all' || trace.kind === 'any') ? trace.children[index] : undefined;
			conditionLines(child, childTrace, thresholds, depth + 1, into);
		});
		return;
	}
	const subject = condition.kind === 'fact' ? `fact ${condition.fact}` : condition.question;
	const ops = condition.operators
		.map((operator) => {
			if ('values' in operator) return `${operator.op} [${operator.values.map((value) => JSON.stringify(value)).join(', ')}]`;
			const value = operator.value;
			if (value !== null && typeof value === 'object') {
				if (value.kind === 'instant') return `${operator.op} ${new Date(value.ms).toISOString()}`;
				if (value.kind === 'number') return `${operator.op} ${value.value}`;
				return `${operator.op} ${value.name} (${thresholds[value.name]})`;
			}
			return `${operator.op} ${JSON.stringify(value)}`;
		})
		.join(', ');
	const seen = trace && (trace.kind === 'fact' || trace.kind === 'question') ? `   = ${JSON.stringify(trace.value)}` : '';
	into.push({ text: `${pad}${mark}${subject} ${ops}${seen}`, ...(tone ? { tone } : {}) });
}

export function thresholdLines(thresholds: Record<string, number>, selected: number): Line[] {
	const names = Object.keys(thresholds);
	if (names.length === 0) return [{ text: 'No thresholds.', tone: 'dim' }];
	const width = Math.max(...names.map((name) => name.length));
	return names.map((name, index) => ({ text: `${name.padEnd(width)}  ${thresholds[name]}`, selected: index === selected }));
}

/** Row 0 is the shared defaults. Case i is row i + 1. */
export function caseLines(results: CaseResult[] | undefined, selectedRow: number, casesError: string | undefined, hasCasesFile: boolean): Line[] {
	if (!hasCasesFile) return [{ text: 'No cases file. Start with --cases <file>.', tone: 'dim' }];
	if (casesError) return [{ text: casesError, tone: 'warn' }];
	const lines: Line[] = [{ text: '◆ defaults · shared by every case', tone: 'accent', selected: selectedRow === 0 }];
	if (!results || results.length === 0) lines.push({ text: '  No cases yet. Press n to add one.', tone: 'dim' });
	(results ?? []).forEach((result, index) =>
		lines.push({
			text: `${result.passed ? '✓' : '✗'} ${result.name}`,
			tone: result.passed ? 'text' : 'hold',
			selected: index + 1 === selectedRow,
		}),
	);
	return lines;
}

/** What the inspector shows above the values for a case: its decision, its failures, and what it expects. */
export function caseHeader(result: CaseResult | undefined, expect: Record<string, unknown> | undefined): Line[] {
	if (!result) return [{ text: 'Select a case.', tone: 'dim' }];
	const lines: Line[] = [];
	if (result.decision) {
		const decision = result.decision;
		lines.push({
			text: `${decision.action} via ${decision.matched_rule ?? 'default'} · gate ${decision.gate}${result.from_facts ? ' · facts only, no server call' : ''}`,
			tone: decision.gate ? 'hold' : 'open',
		});
	} else {
		lines.push({ text: `error: ${result.error ?? 'no decision'}`, tone: 'warn' });
	}
	for (const failure of result.failures) lines.push({ text: `✗ ${failure}`, tone: 'hold' });
	if (expect) {
		const parts = Object.entries(expect).map(([key, value]) => `${key} ${JSON.stringify(value)}`);
		lines.push({ text: `expects ${parts.join(' · ')}`, tone: 'dim' });
	}
	return lines;
}

export const DEFAULTS_HEADER: Line[] = [{ text: 'Shared values. Every case starts from these.', tone: 'accent' }];

export function inspectorLines(header: Line[], values: CaseValue[], selected: number): Line[] {
	const lines = [...header];
	const width = Math.min(36, Math.max(0, ...values.map((value) => labelFor(value).length)));
	values.forEach((value, index) => {
		lines.push({
			text: `${value.own ? '*' : ' '} ${labelFor(value).padEnd(width)}  ${JSON.stringify(value.value)}`,
			tone: value.own ? 'text' : 'dim',
			selected: index === selected,
		});
	});
	if (values.length === 0) lines.push({ text: '  No values. Press n to add a fact or an answer.', tone: 'dim' });
	return lines;
}

function labelFor(value: CaseValue): string {
	return value.kind === 'fact' ? `fact ${value.path}` : `${value.path} (${value.answerType})`;
}
