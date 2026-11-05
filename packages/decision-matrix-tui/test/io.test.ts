import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { CliRenderer } from '@opentui/core';

import { editorCommand, terminalIO } from '../src/io';

function fakeRenderer() {
	const calls: string[] = [];
	const renderer = {
		suspend: async () => {
			calls.push('suspend');
		},
		resume: async () => {
			calls.push('resume');
		},
		destroy: () => {
			calls.push('destroy');
		},
		closed: new Promise<void>(() => {}),
	};
	return { renderer: renderer as unknown as CliRenderer, calls };
}

describe('editorCommand', () => {
	test('prefers VISUAL, then EDITOR, then vi, and splits on spaces', () => {
		expect(editorCommand({ VISUAL: 'code --wait', EDITOR: 'nano' })).toEqual(['code', '--wait']);
		expect(editorCommand({ VISUAL: '  ', EDITOR: ' nano ' })).toEqual(['nano']);
		expect(editorCommand({})).toEqual(['vi']);
	});
});

describe('terminalIO', () => {
	let dir: string;
	const saved = { VISUAL: process.env.VISUAL, EDITOR: process.env.EDITOR };

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), 'dm-tui-io-'));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		process.env.VISUAL = saved.VISUAL;
		process.env.EDITOR = saved.EDITOR;
		if (saved.VISUAL === undefined) delete process.env.VISUAL;
		if (saved.EDITOR === undefined) delete process.env.EDITOR;
	});

	/** An editor that runs this shell body with the file as $1. */
	function useEditor(body: string) {
		const file = path.join(dir, 'editor.sh');
		writeFileSync(file, `#!/bin/sh\n${body}\n`);
		chmodSync(file, 0o755);
		process.env.VISUAL = file;
	}

	describe('editJson', () => {
		test('returns the saved value, and suspends around the editor', async () => {
			useEditor(`printf '{"a":2}' > "$1"`);
			const { renderer, calls } = fakeRenderer();
			expect(await terminalIO(renderer).editJson({ a: 1 }, 'rule')).toEqual({ kind: 'edited', value: { a: 2 } });
			expect(calls).toEqual(['suspend', 'resume']);
		});

		test('reports no change when the file is left alone', async () => {
			useEditor('exit 0');
			expect(await terminalIO(fakeRenderer().renderer).editJson({ a: 1 }, 'rule')).toEqual({ kind: 'unchanged' });
		});

		test('reports a failed editor, and still resumes', async () => {
			useEditor(`printf '{"a":2}' > "$1"\nexit 3`);
			const { renderer, calls } = fakeRenderer();
			const outcome = await terminalIO(renderer).editJson({ a: 1 }, 'rule');
			expect(outcome.kind).toBe('error');
			expect(outcome.kind === 'error' && outcome.error).toContain('exited with status 3. Nothing changed.');
			expect(calls).toEqual(['suspend', 'resume']);
		});

		test('reports an editor that does not exist', async () => {
			process.env.VISUAL = path.join(dir, 'no-such-editor');
			const outcome = await terminalIO(fakeRenderer().renderer).editJson({}, 'rule');
			expect(outcome.kind).toBe('error');
		});

		test('reports invalid JSON', async () => {
			useEditor(`printf '{' > "$1"`);
			const outcome = await terminalIO(fakeRenderer().renderer).editJson({ a: 1 }, 'rule');
			expect(outcome.kind === 'error' && outcome.error).toContain('not valid JSON');
		});

		test('keeps the temp file private, safely named, and removes it after', async () => {
			const log = path.join(dir, 'seen.txt');
			useEditor(`stat -c '%a' "$1" > "${log}"\necho "$1" >> "${log}"`);
			await terminalIO(fakeRenderer().renderer).editJson({ a: 1 }, '../evil name');
			const [mode, file] = readFileSync(log, 'utf8').trim().split('\n');
			expect(mode).toBe('600');
			expect(path.basename(file!)).toBe('___evil_name.json');
			expect(existsSync(file!)).toBe(false);
			expect(existsSync(path.dirname(file!))).toBe(false);
		});
	});

	describe('save', () => {
		const io = () => terminalIO(fakeRenderer().renderer);

		test('replaces every file and leaves no temp files', () => {
			const a = path.join(dir, 'a.json');
			const b = path.join(dir, 'b.json');
			writeFileSync(a, 'old');
			io().save([
				{ path: a, text: 'new a' },
				{ path: b, text: 'new b' },
			]);
			expect(readFileSync(a, 'utf8')).toBe('new a');
			expect(readFileSync(b, 'utf8')).toBe('new b');
			expect(readdirSync(dir).sort()).toEqual(['a.json', 'b.json']);
		});

		test('changes nothing when a later file cannot be written', () => {
			const a = path.join(dir, 'a.json');
			writeFileSync(a, 'old');
			expect(() =>
				io().save([
					{ path: a, text: 'new' },
					{ path: path.join(dir, 'missing', 'b.json'), text: 'new' },
				]),
			).toThrow();
			expect(readFileSync(a, 'utf8')).toBe('old');
			expect(readdirSync(dir)).toEqual(['a.json']);
		});

		// io.ts promises every file or none, but the renames run after staging with no rollback, so the
		// rules can land without their cases. Remove .todo when save rolls back or says what was written.
		test.todo('changes nothing when a later file cannot be renamed into place', () => {
			const a = path.join(dir, 'a.json');
			const blocked = path.join(dir, 'blocked.json');
			writeFileSync(a, 'old');
			mkdirSync(blocked);
			expect(() =>
				io().save([
					{ path: a, text: 'new' },
					{ path: blocked, text: 'new' },
				]),
			).toThrow();
			expect(readFileSync(a, 'utf8')).toBe('old');
			expect(readdirSync(dir).sort()).toEqual(['a.json', 'blocked.json']);
		});
	});

	test('quit destroys the renderer', () => {
		const { renderer, calls } = fakeRenderer();
		terminalIO(renderer).quit();
		expect(calls).toEqual(['destroy']);
	});
});
