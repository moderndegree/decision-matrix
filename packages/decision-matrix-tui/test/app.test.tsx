import { describe, expect, test } from 'bun:test';

import { ciWorkspace, fakeIO, renderApp } from './helpers';

function cell(frame: string, needle: string): { x: number; y: number } {
	const rows = frame.split('\n');
	const y = rows.findIndex((row) => row.includes(needle));
	if (y < 0) throw new Error(`not on screen: ${needle}`);
	return { x: rows[y]!.indexOf(needle), y };
}

async function open(edits: Parameters<typeof fakeIO>[0] = []) {
	const fake = fakeIO(edits);
	const app = await renderApp(ciWorkspace(), fake.io);
	const keys = app.setup.mockInput;
	// A lone Escape is only known once no further bytes follow, so wait past the parser's timeout.
	const escape = () => app.press(async () => {
		keys.pressEscape();
		await new Promise((resolve) => setTimeout(resolve, 80));
	});
	return { ...app, ...fake, keys, escape };
}

describe('decision-matrix-tui', () => {
	test('opens on the rules, the selected rule, thresholds, and every case', async () => {
		const { frame, setup } = await open();
		const screen = await frame();
		expect(screen).toContain('Rules · ci-change.rules.json');
		expect(screen).toContain('1 ● hold-ci-config facts 1✓');
		expect(screen).toContain('10 ○ pass-small-change');
		expect(screen).toContain('Cases 36/36');
		expect(screen).toContain('saved · lint 0 errors 7 warnings · cases 36/36');
		expect(screen).toContain('✓ fact touches_ci eq true   = true');
		setup.renderer.destroy();
	});

	test('raising a threshold loosens the policy, fails the cases it breaks, and the save shows why', async () => {
		const { frame, press, keys, saved, setup } = await open();
		await press(() => keys.pressTab());
		await press(() => keys.pressArrow('down'));
		for (let i = 0; i < 9; i++) await press(() => keys.pressArrow('right'));
		let screen = await frame();
		expect(screen).toContain('injection        0.95');
		expect(screen).toContain('Cases 34/36');
		expect(screen).toContain('✗ text addressing');
		expect(screen).toContain('unsaved (loosens 1, tightens 0)');

		screen = await press(() => keys.pressKey('s', { ctrl: true }));
		expect(screen).toContain('This change LOOSENS the policy. Save? y/n');
		expect(screen).toContain('"hold-injection" matches fewer events after a threshold change');
		expect(saved).toEqual([]);

		screen = await press(() => keys.pressKey('y'));
		expect(saved.map((file) => file.path)).toEqual(['ci-change.rules.json']);
		expect(JSON.parse(saved[0]!.text).thresholds.injection).toBe(0.95);
		expect(screen).toContain('Saved ci-change.rules.json.');
		setup.renderer.destroy();
	});

	test('refuses to open the gate on a model-only rule in a strict policy', async () => {
		const { press, keys, setup } = await open();
		for (let i = 0; i < 3; i++) await press(() => keys.pressArrow('down'));
		const screen = await press(() => keys.pressKey('g'));
		expect(screen).toContain('"hold-injection") opens the gate');
		expect(screen).toContain('4 ● hold-injection');
		setup.renderer.destroy();
	});

	test('moves a rule with shift+arrow, and only a move past a hold counts as loosening', async () => {
		const { press, keys, setup } = await open();
		for (let i = 0; i < 9; i++) await press(() => keys.pressArrow('down'));
		// Past pass-docs: both open the gate, so the order matters only to the docs case.
		let screen = await press(() => keys.pressArrow('up', { shift: true }));
		expect(screen).toContain(' 9 ○ pass-small-change');
		expect(screen).toContain('unsaved (loosens 0, tightens 0)');
		expect(screen).toContain('✗ a docs change');
		// Past auto-merge, then past hold-risk: now it can win where the hold used to.
		await press(() => keys.pressArrow('up', { shift: true }));
		screen = await press(() => keys.pressArrow('up', { shift: true }));
		expect(screen).toContain(' 7 ○ pass-small-change');
		expect(screen).toContain('unsaved (loosens 1, tightens 0)');
		setup.renderer.destroy();
	});

	test('edits a rule in $EDITOR, and keeps the old rule when the edit is invalid', async () => {
		const bad = { kind: 'edited' as const, value: { id: 'hold-ci-config', when: { all: [] }, action: { type: 'hold', target: 't', reason: 'r' } } };
		const good = {
			kind: 'edited' as const,
			value: { id: 'hold-ci-config', when: { all: [{ fact: 'touches_ci', eq: true }] }, action: { type: 'block', target: 'security', reason: 'CI changed', gate: true } },
		};
		const { press, keys, edited, setup } = await open([bad, good]);
		let screen = await press(() => keys.pressKey('e', { shift: true }));
		expect((edited[0] as { id: string }).id).toBe('hold-ci-config');
		expect(screen).toContain('must be a non-empty array');
		expect(screen).toContain('→ hold · security · holds');
		screen = await press(() => keys.pressKey('e', { shift: true }));
		expect(screen).toContain('Rule updated.');
		expect(screen).toContain('→ block · security · holds');
		setup.renderer.destroy();
	});

	test('changes a case answer, then accepts the new decision', async () => {
		const { press, keys, setup } = await open();
		await press(() => keys.pressTab());
		await press(() => keys.pressTab());
		for (let i = 0; i < 3; i++) await press(() => keys.pressArrow('down'));
		await press(() => keys.pressTab());
		let screen = '';
		for (let i = 0; i < 15; i++) screen = await press(() => keys.pressArrow('left'));
		expect(screen).toContain('content_contains_instructions (noul)  0.05');
		expect(screen).toContain('Cases 35/36');
		expect(screen).toContain('pass via pass-small-change');

		await press(() => keys.pressTab({ shift: true }));
		screen = await press(() => keys.pressKey('u'));
		expect(screen).toContain('The case now expects this decision.');
		expect(screen).toContain('Cases 36/36');
		setup.renderer.destroy();
	});

	test('asks before quitting with unsaved changes', async () => {
		const { press, keys, quitCalled, setup } = await open();
		// hold-ci-config reads only facts, so a strict policy lets it open the gate.
		await press(() => keys.pressKey('g'));
		let screen = await press(() => keys.pressKey('q'));
		expect(screen).toContain('Quit without saving? y/n');
		screen = await press(() => keys.pressKey('n'));
		expect(quitCalled()).toBe(false);
		await press(() => keys.pressKey('q'));
		await press(() => keys.pressKey('y'));
		expect(quitCalled()).toBe(true);
		setup.renderer.destroy();
	});

	test('quits at once when nothing changed, and shows help', async () => {
		const { press, keys, quitCalled, setup } = await open();
		const screen = await press(() => keys.pressKey('?'));
		expect(screen).toContain('Keys · any key closes');
		await press(() => keys.pressKey('x'));
		await press(() => keys.pressKey('q'));
		expect(quitCalled()).toBe(true);
		setup.renderer.destroy();
	});

	test('the rule editor shows esc close, and clicking it leaves the editor', async () => {
		const { press, keys, setup } = await open();
		const mouse = setup.mockMouse;
		let screen = await press(() => keys.pressKey('e'));
		expect(screen).toContain('Edit rule hold-ci-config');
		const close = cell(screen, '[esc to close]');
		expect(close.y).toBe(0);
		expect(close.x).toBeGreaterThan(100);
		screen = await press(() => mouse.click(close.x, close.y));
		expect(screen).toContain('Rules · ci-change.rules.json');
		expect(screen).not.toContain('Edit rule');

		screen = await press(() => keys.pressKey('q', { shift: true }));
		expect(screen).toContain('Questions · ci-change.questions.json');
		screen = await press(() => mouse.click(cell(screen, '[esc to close]').x, cell(screen, '[esc to close]').y));
		expect(screen).toContain('Rules · ci-change.rules.json');
		expect(screen).not.toContain('Questions ·');
		setup.renderer.destroy();
	});

	test('esc close dismisses a window without accepting it', async () => {
		const { press, keys, quitCalled, setup } = await open();
		const mouse = setup.mockMouse;
		let screen = await press(() => keys.pressKey('?'));
		expect(screen).toContain('[esc to close]');
		screen = await press(() => mouse.click(cell(screen, '[esc to close]').x, cell(screen, '[esc to close]').y));
		expect(screen).toContain('Rules · ci-change.rules.json');
		expect(screen).not.toContain('Keys · any key closes');

		await press(() => keys.pressKey('g'));
		screen = await press(() => keys.pressKey('q'));
		screen = await press(() => mouse.click(cell(screen, '[esc to close]').x, cell(screen, '[esc to close]').y));
		expect(screen).not.toContain('Quit without saving');
		expect(quitCalled()).toBe(false);
		setup.renderer.destroy();
	});

	test('the mouse selects a row, wheels to the next one, and a second click edits it', async () => {
		const { frame, press, setup } = await open();
		const mouse = setup.mockMouse;
		let screen = await frame();
		const rule = cell(screen, '10 ○ pass-small-change');
		screen = await press(() => mouse.click(rule.x, rule.y));
		expect(screen).toContain('─ pass-small-change ');
		expect(screen).toContain('→ pass · review · opens the gate');

		const first = cell(screen, '1 ● hold-ci-config');
		screen = await press(() => mouse.click(first.x, first.y));
		expect(screen).toContain('─ hold-ci-config ');
		expect(screen).toContain('✓ fact touches_ci eq true');
		screen = await press(() => mouse.scroll(first.x, first.y, 'down'));
		expect(screen).toContain('─ hold-package-scripts ');

		screen = await press(() => mouse.doubleClick(first.x, first.y));
		expect(screen).toContain('Edit rule hold-ci-config');
		setup.renderer.destroy();
	});

	test('a click chooses from a list, and y yes confirms', async () => {
		const { press, keys, saved, quitCalled, setup } = await open();
		const mouse = setup.mockMouse;
		await press(() => keys.pressKey('g'));
		let screen = await press(() => keys.pressKey('q'));
		expect(screen).toContain('Quit without saving? y/n');
		const no = cell(screen, 'n  no');
		screen = await press(() => mouse.click(no.x, no.y));
		expect(screen).not.toContain('Quit without saving');
		expect(quitCalled()).toBe(false);

		screen = await press(() => keys.pressKey('q'));
		const yes = cell(screen, 'y  yes');
		screen = await press(() => mouse.click(yes.x, yes.y));
		expect(quitCalled()).toBe(true);

		screen = await press(() => keys.pressKey('q', { shift: true }));
		const risk = cell(screen, 'risk  score');
		screen = await press(() => mouse.click(risk.x, risk.y));
		expect(screen).toContain('type          score');
		expect(screen).toContain('Levels, lowest (0) first');

		const level = cell(screen, 'No security impact');
		screen = await press(() => mouse.doubleClick(level.x, level.y));
		expect(screen).toContain('Level 0');
		expect(saved).toEqual([]);
		setup.renderer.destroy();
	});
});

describe('rule editor', () => {
	/** Opens the editor on rule 4, hold-injection. The cursor starts on its ALL group. */
	async function openInjection() {
		const app = await open();
		for (let i = 0; i < 3; i++) await app.press(() => app.keys.pressArrow('down'));
		const screen = await app.press(() => app.keys.pressKey('e'));
		return { ...app, screen };
	}

	test('opens a form for the rule with a plain-language preview', async () => {
		const { screen, setup } = await openInjection();
		expect(screen).toContain('Edit rule hold-injection');
		expect(screen).toContain('question content_contains_instructions  (noul)');
		expect(screen).toContain('is at least  injection (0.5)');
		// The preview wraps the sentence rather than cutting it off.
		expect(screen).toContain('• content_contains_instructions is at least');
		expect(screen).toMatch(/│ {5}injection \(0\.5\) +│/);
		expect(screen).toContain('✓ Valid');
		setup.renderer.destroy();
	});

	test('picks a threshold, previews what it loosens, and applies it', async () => {
		const { press, keys, setup } = await openInjection();
		await press(() => keys.pressArrow('down'));
		await press(() => keys.pressArrow('down'));
		let screen = await press(() => keys.pressEnter());
		expect(screen).toContain('Compare with a threshold or a number · now injection (0.5)');
		await press(() => keys.pressArrow('up'));
		screen = await press(() => keys.pressEnter());
		expect(screen).toContain('is at least  high_confidence (0.85)');
		expect(screen).toContain('loosens: "hold-injection" matches fewer events');
		expect(screen).toContain('Cases that change: 2 of 36');

		screen = await press(() => keys.pressKey('s', { ctrl: true }));
		expect(screen).toContain('Rule applied. ctrl+s saves the file.');
		expect(screen).toContain('Cases 34/36');
		// The status message gives way to the summary on the next key.
		screen = await press(() => keys.pressArrow('down'));
		expect(screen).toContain('unsaved (loosens 1, tightens 0)');
		setup.renderer.destroy();
	});

	test('will not apply a rule the model alone could open in a strict policy', async () => {
		const { press, keys, setup } = await openInjection();
		for (let i = 0; i < 1; i++) await press(() => keys.pressArrow('up'));
		let screen = await press(() => keys.pressKey(' '));
		expect(screen).toContain('○ opens the gate');
		expect(screen).toContain('✗ Not valid yet');
		screen = await press(() => keys.pressKey('s', { ctrl: true }));
		expect(screen).toContain('Fix this first:');
		expect(screen).toContain('Edit rule hold-injection');
		setup.renderer.destroy();
	});

	test('adds a condition next to the selected one and applies the group', async () => {
		const { press, keys, setup } = await openInjection();
		await press(() => keys.pressArrow('down'));
		let screen = await press(() => keys.pressKey('a'));
		expect(screen).toContain('all of these are true:');
		// The new condition is selected. Point it at a fact instead.
		screen = await press(() => keys.pressEnter());
		expect(screen).toContain('Check which question or fact?');
		// Five questions, then the facts in alphabetical order: docs_only is the twelfth option.
		for (let i = 0; i < 11; i++) await press(() => keys.pressArrow('down'));
		screen = await press(() => keys.pressEnter());
		expect(screen).toContain('fact docs_only');
		// The cases show docs_only as true or false, so the comparison starts as "is false".
		expect(screen).toContain('• the fact docs_only is false');
		screen = await press(() => keys.pressKey('s', { ctrl: true }));
		expect(screen).toContain('Rule applied.');
		setup.renderer.destroy();
	});

	test('a new rule opens in the editor, and cancelling removes it', async () => {
		const { press, keys, escape, setup } = await open();
		let screen = await press(() => keys.pressKey('n'));
		expect(screen).toContain('Edit rule new-rule-1');
		screen = await escape();
		expect(screen).toContain('New rule discarded.');
		expect(screen).not.toContain('new-rule-1');
		screen = await press(() => keys.pressArrow('down'));
		expect(screen).toContain('saved ·');
		setup.renderer.destroy();
	});

	test('asks before discarding edits', async () => {
		const { press, keys, escape, setup } = await openInjection();
		await press(() => keys.pressKey(' '));
		let screen = await escape();
		expect(screen).toContain('Discard the changes to this rule? y/n');
		screen = await press(() => keys.pressKey('y'));
		expect(screen).toContain('No changes applied.');
		screen = await press(() => keys.pressArrow('down'));
		expect(screen).toContain('saved ·');
		setup.renderer.destroy();
	});
});
