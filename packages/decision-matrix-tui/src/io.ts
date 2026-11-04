import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { CliRenderer } from '@opentui/core';

/** What the app needs from the outside world. Tests pass a fake. */
export interface AppIO {
	/** Opens the value as JSON in the user's editor and returns what they saved. */
	editJson(value: unknown, label: string): Promise<EditOutcome>;
	/** Writes every file, or none if one fails to write. */
	save(files: Array<{ path: string; text: string }>): void;
	quit(): void;
}

export type EditOutcome = { kind: 'edited'; value: unknown } | { kind: 'unchanged' } | { kind: 'error'; error: string };

export function terminalIO(renderer: CliRenderer): AppIO {
	return {
		async editJson(value, label) {
			const command = editorCommand(process.env);
			// A private directory, so another local user cannot read or swap the file.
			const dir = mkdtempSync(path.join(tmpdir(), 'decision-matrix-'));
			const file = path.join(dir, `${label.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
			const before = `${JSON.stringify(value, null, 2)}\n`;
			try {
				writeFileSync(file, before, { mode: 0o600 });
				await renderer.suspend();
				let status: number | null;
				try {
					// No shell: the command and the file are separate arguments.
					status = spawnSync(command[0]!, [...command.slice(1), file], { stdio: 'inherit' }).status;
				} finally {
					await renderer.resume();
				}
				if (status !== 0) return { kind: 'error', error: `${command[0]} exited with status ${status}. Nothing changed.` };
				const after = readFileSync(file, 'utf8');
				if (after === before) return { kind: 'unchanged' };
				try {
					return { kind: 'edited', value: JSON.parse(after) };
				} catch (error) {
					return { kind: 'error', error: `The edited file is not valid JSON, so nothing changed. ${(error as Error).message}` };
				}
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		save(files) {
			const staged: Array<{ temp: string; target: string }> = [];
			try {
				for (const file of files) {
					const temp = path.join(path.dirname(file.path), `.${path.basename(file.path)}.${process.pid}.tmp`);
					staged.push({ temp, target: file.path });
					writeFileSync(temp, file.text);
				}
			} catch (error) {
				for (const { temp } of staged) rmSync(temp, { force: true });
				throw error;
			}
			// Same directory, so each rename replaces its file in one step.
			for (const { temp, target } of staged) renameSync(temp, target);
		},
		quit() {
			renderer.destroy();
			void renderer.closed.then(() => process.exit(0));
		},
	};
}

/** $VISUAL, then $EDITOR, then vi. Split on spaces so "code --wait" works. */
export function editorCommand(env: Record<string, string | undefined>): string[] {
	const raw = env.VISUAL?.trim() || env.EDITOR?.trim() || 'vi';
	return raw.split(/\s+/);
}
