import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { AnswerView } from 'decision-matrix-rules';
import type { CI_CHANGE_QUESTIONS } from 'decision-matrix-systemone';

import type { CliIO } from '../src';

export const packageRoot = path.resolve(__dirname, '..');
export const examples = path.join(packageRoot, 'examples');

export function readExample(name: string): string {
	return readFileSync(path.join(examples, name), 'utf8');
}

export function noul(value: number): AnswerView {
	return { type: 'noul', noul: value };
}

export function score(value: number, confidence = 0.9): AnswerView {
	return { type: 'score', score: value, confidence };
}

/** A CliIO whose files come from a map, with stdout and stderr captured. */
export function captured(argv: string[], files: Record<string, string> = {}, extra: Partial<CliIO> = {}) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const io: CliIO = {
		argv,
		env: extra.env ?? {},
		stdinIsTTY: extra.stdinIsTTY ?? true,
		readStdin: extra.readStdin ?? (async () => ''),
		readFile: async (filePath) => {
			const text = files[filePath];
			if (text === undefined) throw new Error(`Could not read ${filePath}. missing`);
			return text;
		},
		stdout: (text) => {
			stdout.push(text);
		},
		stderr: (text) => {
			stderr.push(text);
		},
	};
	return { io, stdout, stderr };
}

export const CI_FACTS = {
	author: 'octocat',
	author_association: 'MEMBER',
	author_is_dependency_bot: false,
	dependency_update_type: null,
	from_fork: false,
	files_changed: 3,
	touches_ci: false,
	touches_dependencies: false,
	touches_sensitive: false,
	docs_only: false,
	changes_package_scripts: false,
	new_package_count: 0,
	new_packages: [],
	diff_truncated: false,
};

export function ciAnswers(overrides: Partial<Record<keyof typeof CI_CHANGE_QUESTIONS, AnswerView>> = {}) {
	return {
		content_contains_instructions: noul(0.02),
		suspicious_code: noul(0.02),
		description_matches_diff: noul(0.95),
		changes_runtime_behavior: noul(0.9),
		risk: score(1),
		...overrides,
	};
}

/** A minimal ruleset that holds by default, for tests that build their own rules. */
export function rules(list: unknown[], extra: Record<string, unknown> = {}) {
	return {
		version: 1,
		default_action: { type: 'hold', target: 'human', reason: 'No matching rule', gate: true },
		thresholds: { high: 0.8 },
		rules: list,
		...extra,
	};
}

export function rule(id: string, when: unknown, gate = true) {
	return { id, when, action: { type: gate ? 'hold' : 'pass', target: 't', reason: `Rule ${id}`, gate } };
}
