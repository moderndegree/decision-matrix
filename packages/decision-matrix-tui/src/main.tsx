#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';

import { App } from './app';
import { terminalIO } from './io';
import { NEW_CASES, createWorkspace } from './model';

const HELP = `decision-matrix-tui — edit and test a decision-matrix policy

Usage:
  decision-matrix-tui --rules <file> [--cases <file>] [--questions <file>]

  --rules <file>      The ruleset to edit. Saved in place with ctrl+s.
  --cases <file>      Policy cases. Every edit re-runs them. A path that
                      does not exist starts a new cases file.
  --questions <file>  The questions the rules read. Q edits them, and they
                      fill the pickers and the lint. A path that does not
                      exist starts a new questions file.

Every save shows what the change does to the policy first. Press ? in the
editor for keys.
`;

function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch (error) {
		throw new Error(`Could not read ${file}. ${(error as Error).message}`);
	}
}

async function main(): Promise<number> {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			rules: { type: 'string' },
			cases: { type: 'string' },
			questions: { type: 'string' },
			help: { type: 'boolean', short: 'h' },
		},
		strict: true,
	});
	if (values.help) {
		process.stdout.write(HELP);
		return 0;
	}
	if (!values.rules) {
		process.stderr.write(`--rules <file> is required.\n\n${HELP}`);
		return 1;
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		process.stderr.write('decision-matrix-tui needs a terminal. For scripts and CI, use decision-matrix test, check, and diff.\n');
		return 1;
	}
	// `pnpm tui` runs in this package's directory. pnpm keeps the directory the
	// command was typed in as INIT_CWD, so paths resolve from there.
	const base = process.env.INIT_CWD || process.cwd();
	const local = (file: string) => path.relative(process.cwd(), path.resolve(base, file));
	const rulesPath = local(values.rules);
	const casesPath = values.cases ? local(values.cases) : undefined;
	const questionsPath = values.questions ? local(values.questions) : undefined;
	// Cases and questions files may be new. They are written on the first save that changes them.
	const workspace = createWorkspace({
		rulesPath,
		rules: readJson(rulesPath),
		...(casesPath ? { casesPath, cases: existsSync(casesPath) ? readJson(casesPath) : NEW_CASES } : {}),
		...(questionsPath ? { questionsPath, questions: existsSync(questionsPath) ? readJson(questionsPath) : {} } : {}),
	});
	const renderer = await createCliRenderer({ exitOnCtrlC: false });
	renderer.setTerminalTitle(`decision-matrix · ${path.basename(rulesPath)}`);
	createRoot(renderer).render(<App initial={workspace} io={terminalIO(renderer)} />);
	return -1;
}

main().then(
	(code) => {
		if (code >= 0) process.exit(code);
	},
	(error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	},
);
