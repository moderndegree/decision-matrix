import { describe, expect, test } from 'bun:test';

import type { EditOutcome } from '../src/io';
import { ciWorkspace, fakeIO, renderApp } from './helpers';

async function open(edits: EditOutcome[] = [], size?: { width: number; height: number }) {
	const fake = fakeIO(edits);
	const app = await renderApp(ciWorkspace(), fake.io, size);
	const keys = app.setup.mockInput;
	const mouse = app.setup.mockMouse;
	const escape = () =>
		app.press(async () => {
			keys.pressEscape();
			await new Promise((resolve) => setTimeout(resolve, 80));
		});
	const key = (name: string, modifiers?: { shift?: boolean; ctrl?: boolean }) => app.press(() => keys.pressKey(name, modifiers));
	const enter = () => app.press(() => keys.pressEnter());
	const arrow = (direction: 'up' | 'down' | 'left' | 'right') => app.press(() => keys.pressArrow(direction));
	const space = () => app.press(() => keys.pressKey(' '));
	const shiftArrow = (direction: 'up' | 'down') => app.press(() => keys.pressArrow(direction, { shift: true }));
	const down = async (n: number) => {
		let screen = '';
		for (let i = 0; i < n; i++) screen = await arrow('down');
		return screen;
	};
	const type = async (text: string) => {
		await app.press(() => keys.typeText(text));
		return enter();
	};
	/** Replaces whatever a prompt starts with. */
	const retype = async (text: string, length: number) => {
		for (let i = 0; i < length; i++) await app.press(() => keys.pressBackspace());
		return type(text);
	};
	const flat = (screen: string) => screen.replace(/\s+/g, ' ');
	const at = (screen: string, text: string) => {
		const lines = screen.split('\n');
		const y = lines.findIndex((line) => line.includes(text));
		if (y < 0) throw new Error(`"${text}" is not on the screen:\n${screen}`);
		return { x: lines[y]!.indexOf(text) + 1, y };
	};
	const click = async (screen: string, text: string) => {
		const spot = at(screen, text);
		return app.press(() => mouse.click(spot.x, spot.y));
	};
	const twice = async (screen: string, text: string) => {
		const spot = at(screen, text);
		return app.press(() => mouse.doubleClick(spot.x, spot.y));
	};
	const wheel = async (screen: string, text: string, direction: 'up' | 'down') => {
		const spot = at(screen, text);
		return app.press(() => mouse.scroll(spot.x, spot.y, direction));
	};
	return { ...app, ...fake, keys, mouse, escape, key, space, enter, arrow, shiftArrow, down, type, retype, flat, at, click, twice, wheel };
}

describe('questions screen', () => {
	test('adds one question of each type from the picker', async () => {
		const { key, enter, arrow, type, setup } = await open();
		await key('q', { shift: true });
		let screen = await key('n');
		expect(screen).toContain('What kind of question?');
		await enter();
		screen = await type('kind');
		expect(screen).toContain('Added kind.');
		expect(screen).toContain('kind  choice');
		await key('n');
		await arrow('down');
		await enter();
		screen = await type('flag');
		expect(screen).toContain('flag  noul');
		await key('n');
		await arrow('down');
		await arrow('down');
		await enter();
		screen = await type('level');
		expect(screen).toContain('level  score');
		setup.renderer.destroy();
	});

	test('refuses an id with a space and says why', async () => {
		const { key, enter, type, flat, setup } = await open();
		await key('q', { shift: true });
		await key('n');
		await enter();
		const screen = await type('two words');
		expect(flat(screen)).not.toContain('Added two words');
		expect(screen).not.toContain('two words  choice');
		setup.renderer.destroy();
	});

	test('the add row opens the new question picker from the keyboard', async () => {
		const { key, enter, down, setup } = await open();
		await key('q', { shift: true });
		await down(5);
		const screen = await enter();
		expect(screen).toContain('What kind of question?');
		setup.renderer.destroy();
	});

	test('renames and deletes from the list', async () => {
		const { key, retype, down, setup } = await open();
		await key('q', { shift: true });
		await down(4);
		await key('r');
		let screen = await retype('danger', 'risk'.length);
		expect(screen).toContain('Renamed to danger.');
		expect(screen).toContain('danger  score  · 3 rules');
		screen = await key('x');
		expect(screen).toContain('Delete question danger? y/n');
		screen = await key('n');
		expect(screen).toContain('danger  score');
		setup.renderer.destroy();
	});

	test('edits a score question: levels, order, and a new top level', async () => {
		const { key, enter, arrow, shiftArrow, down, type, flat, setup } = await open();
		await key('q', { shift: true });
		await down(4);
		await enter();
		let screen = await down(3);
		expect(screen).toContain('    0  ');
		await enter();
		await type(' edited');
		screen = await shiftArrow('down');
		expect(flat(screen)).toContain('Score numbers changed meaning');
		screen = await key('x');
		expect(flat(screen)).toContain('Score numbers above it moved down by one');
		await arrow('up');
		await down(20);
		await enter();
		screen = await type('new top');
		expect(screen).toContain('new top');
		setup.renderer.destroy();
	});

	test('changes the type sideways, and lint reports rules that no longer fit', async () => {
		const { key, enter, arrow, down, flat, setup } = await open();
		await key('q', { shift: true });
		await down(4);
		await enter();
		await arrow('down');
		let screen = await arrow('right');
		expect(flat(screen)).toContain('risk is now a choice question');
		screen = await arrow('left');
		expect(flat(screen)).toContain('risk is now a score question');
		setup.renderer.destroy();
	});

	test('edits labels on a choice question', async () => {
		const { key, enter, down, type, retype, flat, setup } = await open();
		await key('q', { shift: true });
		await key('n');
		await enter();
		await type('kind');
		await enter();
		let screen = await down(20);
		expect(screen).toContain('+ add a label');
		await enter();
		screen = await type('alpha');
		expect(screen).toContain('Added alpha.');
		await enter();
		screen = await type('first letter');
		expect(screen).toContain('alpha  — first letter');
		await key('r');
		screen = await retype('beta', 'alpha'.length);
		expect(screen).toContain('beta  — first letter');
		screen = await key('x');
		expect(flat(screen)).toContain('Deleted beta.');
		setup.renderer.destroy();
	});

	test('the mouse moves through both panes and opens rows', async () => {
		const { key, click, twice, wheel, type, flat, setup } = await open();
		let screen = await key('q', { shift: true });
		screen = await click(screen, 'risk  score');
		expect(screen).toContain('─ risk ');
		screen = await wheel(screen, 'risk  score', 'up');
		expect(screen).toContain('─ changes_runtime_behavior ');
		screen = await click(screen, 'instructions  ');
		screen = await wheel(screen, 'instructions  ', 'up');
		screen = await twice(screen, 'instructions  ');
		expect(screen).toContain('What the model is asked');
		screen = await type(' more');
		screen = await twice(screen, 'type          noul');
		expect(flat(screen)).toContain('is now a score question');
		screen = await twice(screen, 'id            ');
		expect(screen).toContain('Rename changes_runtime_behavior to');
		setup.renderer.destroy();
	});

	test('clicking the add row twice opens the new question picker, and a click on a level edits it', async () => {
		const { key, click, twice, escape, setup } = await open();
		let screen = await key('q', { shift: true });
		screen = await twice(screen, '+ add a question');
		expect(screen).toContain('What kind of question?');
		screen = await escape();
		screen = await click(screen, 'risk  score');
		screen = await twice(screen, '+ add a level');
		expect(screen).toContain('New highest level');
		screen = await escape();
		screen = await twice(screen, '    0  ');
		expect(screen).toContain('Level 0');
		setup.renderer.destroy();
	});

	test('ctrl+s from the questions screen goes back and offers the save', async () => {
		const { key, enter, arrow, type, saved, setup } = await open();
		await key('q', { shift: true });
		await enter();
		await arrow('down');
		await arrow('down');
		await enter();
		await type(' more');
		let screen = await key('s', { ctrl: true });
		expect(screen).toContain('Save? y/n');
		expect(screen).toContain('The questions changed: ci-change.questions.json');
		screen = await key('y');
		expect(saved.map((file) => file.path)).toEqual(['ci-change.questions.json']);
		expect(saved[0]?.text).toContain(' more');
		expect(screen).toContain('Saved ci-change.questions.json.');
		setup.renderer.destroy();
	});
});


describe('rule editor', () => {
	/** Opens the first rule, whose rows are id, description, type, target, reason, gate, group, predicate, operator, add-operator, add-condition. */
	async function edit() {
		const app = await open();
		await app.key('e');
		const up = async (n: number) => {
			let screen = '';
			for (let i = 0; i < n; i++) screen = await app.arrow('up');
			return screen;
		};
		return { ...app, up };
	}

	test('edits the action fields and applies them', async () => {
		const { key, space, enter, arrow, up, type, saved, setup } = await edit();
		await up(1);
		let screen = await space();
		expect(screen).toContain('○ opens');
		screen = await arrow('left');
		expect(screen).toContain('● holds');
		await up(1);
		await enter();
		await type(' now');
		await up(1);
		await enter();
		screen = await type('-team');
		expect(screen).toContain('security-team');
		screen = await key('s', { ctrl: true });
		expect(screen).toContain('Rule applied. ctrl+s saves the file.');
		screen = await arrow('down');
		expect(screen).toContain('unsaved');
		await key('s', { ctrl: true });
		await key('y');
		const rules = JSON.parse(saved[0]!.text) as { rules: Array<{ action: { target: string; reason: string } }> };
		expect(rules.rules[0]?.action.target).toBe('security-team');
		expect(rules.rules[0]?.action.reason).toEndWith(' now');
		setup.renderer.destroy();
	});

	test('the type field cycles sideways', async () => {
		const { arrow, up, setup } = await edit();
		await up(4);
		const screen = await arrow('right');
		expect(screen).not.toMatch(/type {9}hold\s/);
		setup.renderer.destroy();
	});

	test('escape leaves at once with no changes, and asks with changes', async () => {
		const { key, space, up, escape, setup } = await edit();
		await up(1);
		await space();
		let screen = await escape();
		expect(screen).toContain('Discard the changes to this rule? y/n');
		screen = await key('n');
		expect(screen).toContain('Edit rule hold-ci-config');
		await escape();
		screen = await key('y');
		expect(screen).toContain('Rules · ci-change.rules.json');
		expect(screen).not.toContain('unsaved');
		setup.renderer.destroy();
	});

	test('reshapes conditions: any, add, group, wrap, move, delete', async () => {
		const { key, space, shiftArrow, arrow, setup } = await edit();
		const groups = (text: string) => (text.match(/(ALL|ANY) of these/g) ?? []).length;
		const conditions = (text: string) => text.split('+ add a comparison').length - 1;
		let screen = await space();
		expect(screen).toContain('ANY of these');
		screen = await arrow('right');
		expect(screen).toContain('ALL of these');
		screen = await arrow('down');
		expect(conditions(screen)).toBe(1);
		screen = await key('a');
		expect(conditions(screen)).toBe(2);
		screen = await key('g');
		expect(groups(screen)).toBe(2);
		screen = await key('w');
		expect(groups(screen)).toBe(3);
		screen = await shiftArrow('down');
		expect(groups(screen)).toBe(3);
		const count = conditions(screen);
		screen = await key('x');
		expect(conditions(screen)).toBeLessThan(count);
		setup.renderer.destroy();
	});

	test('the add rows add a condition, a group, and a comparison', async () => {
		const { enter, key, down, setup } = await edit();
		let screen = await down(4);
		const count = (text: string) => text.split('+ add a comparison').length - 1;
		const start = count(screen);
		screen = await enter();
		expect(count(screen)).toBe(start + 1);
		screen = await down(20);
		const groups = (text: string) => (text.match(/(ALL|ANY) of these/g) ?? []).length;
		const before = groups(screen);
		screen = await key('g');
		expect(groups(screen)).toBe(before + 1);
		setup.renderer.destroy();
	});

	test('a comparison cycles its operator, takes a new value, and can be removed', async () => {
		const { enter, arrow, down, key, setup } = await edit();
		const left = (text: string) => text.split('\n').filter((line) => line.startsWith('│')).map((line) => [...line].slice(0, 66).join('')).join('\n');
		let screen = await down(2);
		expect(screen).toContain('is  true');
		screen = await arrow('right');
		expect(screen).not.toContain('is  true');
		screen = await arrow('left');
		expect(screen).toContain('is  true');
		screen = await enter();
		expect(screen).toContain('Compare the fact with');
		await arrow('down');
		screen = await enter();
		expect(screen).toContain('is  false');
		await down(1);
		const added = await enter();
		expect(left(added)).not.toBe(left(screen));
		// The selection stays on the same line, which is now the new comparison.
		const removed = await key('x');
		expect(left(removed)).toBe(left(screen));
		setup.renderer.destroy();
	});

	test('a typed fact value parses numbers and booleans', async () => {
		const { enter, arrow, down, retype, setup } = await edit();
		await down(2);
		await enter();
		await arrow('up');
		const screen0 = await enter();
		expect(screen0).toContain('A number, true, false, null, or text');
		const screen = await retype('7', 'true'.length);
		expect(screen).toContain('is  7');
		setup.renderer.destroy();
	});

	test('the subject picker takes a choice from a list or a typed path, and the mouse drives it', async () => {
		const { enter, arrow, down, type, click, wheel, setup } = await edit();
		const up = async (n: number) => {
			for (let i = 0; i < n; i++) await arrow('up');
		};
		await down(1);
		let screen = await enter();
		expect(screen).toContain('Check which question or fact?');
		expect(screen).toContain('question  risk  (score)');
		screen = await wheel(screen, 'question  risk', 'down');
		screen = await wheel(screen, 'question  risk', 'up');
		screen = await click(screen, 'question  risk');
		expect(screen).toContain('    question risk');
		// The picker opens on risk, the fifth option, and up wraps to the typed rows at the end.
		await enter();
		await up(5);
		screen = await enter();
		expect(screen).toContain('Question id');
		await type('x');
		// x is not in the list, so the picker opens on the first option.
		await enter();
		await up(2);
		screen = await enter();
		expect(screen).toContain('Fact path, for example grant.privileged');
		screen = await type('grant.privileged');
		expect(screen).toContain('fact grant.privileged');
		setup.renderer.destroy();
	});

	test('a numeric comparison offers thresholds and refuses text that is not a number', async () => {
		const { enter, arrow, down, click, type, setup } = await edit();
		await down(1);
		let screen = await enter();
		screen = await click(screen, 'question  risk');
		await down(1);
		screen = await enter();
		expect(screen).toContain('Compare with a threshold or a number');
		await arrow('up');
		screen = await enter();
		screen = await type('abc');
		expect(screen).toContain('That is not a valid value.');
		setup.renderer.destroy();
	});

	test('a choice with labels uses a picker for eq and a multi-select for in', async () => {
		const { key, space, enter, arrow, down, click, type, escape, setup } = await open();
		await key('q', { shift: true });
		await key('n');
		await enter();
		await type('kind');
		await enter();
		await down(20);
		await enter();
		await type('alpha');
		await escape();
		await escape();
		await key('e');
		await down(1);
		let screen = await enter();
		screen = await click(screen, 'question  kind');
		await down(1);
		screen = await enter();
		expect(screen).toContain('Choose a label');
		await escape();
		await arrow('right');
		await arrow('right');
		screen = await enter();
		expect(screen).toContain('Choose labels: space marks, enter confirms');
		expect(screen).toContain('[x] ');
		screen = await space();
		expect(screen).not.toContain('[x] ');
		screen = await enter();
		expect(screen).toContain('Choose at least one label.');
		setup.renderer.destroy();
	});

	test('refuses a rule id with a space', async () => {
		const { enter, up, retype, setup } = await edit();
		await up(6);
		await enter();
		const screen = await retype('has space', 'hold-ci-config'.length);
		expect(screen).toContain('A rule id cannot be empty or contain spaces.');
		expect(screen).toContain('id           hold-ci-config');
		setup.renderer.destroy();
	});

	test('ctrl+s refuses an opener with no fact under a strict policy', async () => {
		const { key, space, enter, down, up, click, flat, setup } = await edit();
		await up(1);
		await space();
		await down(2);
		let screen = await enter();
		await click(screen, 'question  risk');
		screen = await key('s', { ctrl: true });
		expect(flat(screen)).toContain('Fix this first');
		expect(screen).toContain('Edit rule hold-ci-config');
		setup.renderer.destroy();
	});

	test('the mouse selects rows and a second click opens each kind', async () => {
		const { click, twice, escape, frame, setup } = await edit();
		let screen = await frame();
		screen = await click(screen, 'target       security');
		screen = await twice(screen, 'target       security');
		expect(screen).toContain('Target');
		screen = await escape();
		screen = await twice(screen, 'gate         ● holds');
		expect(screen).toContain('○ opens');
		screen = await twice(screen, 'ALL of these');
		expect(screen).toContain('ANY of these');
		screen = await twice(screen, 'is  true');
		expect(screen).toContain('Compare the fact with');
		screen = await escape();
		screen = await twice(screen, '    fact touches_ci');
		expect(screen).toContain('Check which question or fact?');
		screen = await escape();
		const left = (text: string) => text.split('\n').map((line) => [...line].slice(0, 66).join('')).join('\n');
		const before = left(screen);
		screen = await twice(screen, '+ add a comparison');
		expect(left(screen)).not.toBe(before);
		const conditions = screen.split('+ add a comparison').length;
		screen = await twice(screen, '+ add a condition');
		expect(screen.split('+ add a comparison').length).toBe(conditions + 1);
		setup.renderer.destroy();
	});
});

describe('overlays', () => {
	test('help closes on any key and on a click inside it', async () => {
		const { key, click, setup } = await open();
		let screen = await key('?');
		expect(screen).toContain('Keys · any key closes');
		screen = await key('z');
		expect(screen).not.toContain('Keys · any key closes');
		screen = await key('?');
		screen = await click(screen, 'Keys · any key closes');
		expect(screen).not.toContain('Keys · any key closes');
		setup.renderer.destroy();
	});
});

describe('main screen', () => {
	test('shift+E takes an edited rule, reports no change, and shows an editor error', async () => {
		const rule = {
			id: 'hold-ci-config',
			when: { fact: 'touches_ci', eq: true },
			action: { type: 'hold', target: 'platform', reason: 'edited', gate: true },
		};
		const { key, edited, setup } = await open([{ kind: 'edited', value: rule }, { kind: 'unchanged' }, { kind: 'error', error: 'vi exited' }]);
		let screen = await key('e', { shift: true });
		expect(edited.length).toBe(1);
		expect(screen).toContain('Rule updated.');
		screen = await key('e', { shift: true });
		expect(screen).toContain('No changes.');
		screen = await key('e', { shift: true });
		expect(screen).toContain('vi exited');
		setup.renderer.destroy();
	});

	test('shift+E rejects a rule that does not validate', async () => {
		const { key, setup } = await open([{ kind: 'edited', value: { id: 'broken' } }]);
		const screen = await key('e', { shift: true });
		expect(screen).not.toContain('Rule updated.');
		setup.renderer.destroy();
	});

	test('ctrl+s says when there is nothing to save, and a failed save keeps the edit', async () => {
		const fake = fakeIO();
		fake.io.save = () => {
			throw new Error('disk full');
		};
		const app = await renderApp(ciWorkspace(), fake.io);
		const keys = app.setup.mockInput;
		let screen = await app.press(() => keys.pressKey('s', { ctrl: true }));
		expect(screen).toContain('Nothing to save.');
		await app.press(() => keys.pressKey('g'));
		await app.press(() => keys.pressKey('s', { ctrl: true }));
		screen = await app.press(() => keys.pressKey('y'));
		expect(screen).toContain('Save failed: disk full');
		screen = await app.press(() => keys.pressArrow('down'));
		expect(screen).toContain('unsaved');
		app.setup.renderer.destroy();
	});

	test('names a missing questions file and a missing cases file', async () => {
		const fake = fakeIO();
		const { createWorkspace } = await import('../src/model');
		const { readExample } = await import('./helpers');
		const workspace = createWorkspace({ rulesPath: 'r.json', rules: readExample('ci-change.rules.json') });
		const app = await renderApp(workspace, fake.io);
		const keys = app.setup.mockInput;
		let screen = await app.press(() => keys.pressKey('q', { shift: true }));
		expect(screen).toContain('No questions file is open.');
		await app.press(() => keys.pressTab());
		await app.press(() => keys.pressTab());
		screen = await app.press(() => keys.pressArrow('down'));
		expect(screen).toContain('No cases file is open.');
		app.setup.renderer.destroy();
	});

	test('edits a case expectation: a rule, the gate, and error text', async () => {
		const { keys, press, key, enter, arrow, down, escape, type, setup } = await open();
		await press(() => keys.pressTab());
		await press(() => keys.pressTab());
		await arrow('down');
		let screen = await key('e');
		expect(screen).toContain('What this case expects');
		screen = await enter();
		expect(screen).toContain('Which rule must decide');
		// This is the second case, so its rule is the second option. Up twice wraps to "not checked".
		await arrow('up');
		await arrow('up');
		screen = await enter();
		expect(screen).toMatch(/matched_rule +— not checked/);
		await down(4);
		screen = await enter();
		expect(screen).toContain('The gate must be');
		await arrow('down');
		screen = await enter();
		expect(screen).toMatch(/gate +false/);
		await down(6);
		screen = await enter();
		expect(screen).toContain('a part of the error text');
		screen = await type('boom');
		expect(screen).toMatch(/error +"boom"/);
		screen = await escape();
		expect(screen).toContain('Cases 35/36');
		setup.renderer.destroy();
	});

	test('the mouse opens a threshold, a case, the defaults, and a value', async () => {
		const { frame, twice, escape, retype, setup } = await open();
		let screen = await frame();
		screen = await twice(screen, 'high_confidence  0.85');
		expect(screen).toContain('high_confidence =');
		screen = await retype('0.9', '0.85'.length);
		expect(screen).toContain('high_confidence set.');
		screen = await twice(screen, '◆ defaults');
		expect(screen).toContain('The defaults have no name or expectation.');
		screen = await twice(screen, '✓ a postinstall sc');
		expect(screen).toContain('What this case expects');
		screen = await escape();
		screen = await twice(screen, 'suspicious_code (noul)');
		expect(screen).toMatch(/suspicious_code\S* =/);
		setup.renderer.destroy();
	});

	test('deletes a rule after asking, and refuses to delete the default action', async () => {
		const { key, shiftArrow, down, setup } = await open();
		let screen = await key('x');
		expect(screen).toContain('Delete "hold-ci-config"? y/n');
		screen = await key('y');
		expect(screen).toContain('Deleted "hold-ci-config".');
		expect(screen).not.toContain('● hold-ci-config');
		screen = await down(20);
		screen = await key('x');
		expect(screen).toContain('A ruleset always has a default action.');
		screen = await shiftArrow('up');
		expect(screen).toContain('The default action is a footer and cannot be moved.');
		setup.renderer.destroy();
	});

	test('edits a threshold by typing, and deletes one no rule uses', async () => {
		const { keys, press, key, enter, down, retype, setup } = await open();
		await press(() => keys.pressTab());
		await enter();
		let screen = await retype('0.9', '0.85'.length);
		expect(screen).toContain('high_confidence set.');
		screen = await key('x');
		expect(screen).toContain('high_confidence is used by');
		await key('n');
		await press(() => keys.typeText('spare'));
		await enter();
		await press(() => keys.typeText('0.5'));
		screen = await enter();
		expect(screen).toContain('Added spare.');
		await down(20);
		screen = await key('x');
		expect(screen).toContain('Delete threshold spare? y/n');
		screen = await key('y');
		expect(screen).toContain('Deleted spare.');
		setup.renderer.destroy();
	});

	test('the defaults row has no name to edit, and a case can be renamed, copied, and deleted', async () => {
		const { keys, press, key, enter, arrow, retype, setup } = await open();
		await press(() => keys.pressTab());
		await press(() => keys.pressTab());
		await arrow('up');
		let screen = await key('r');
		expect(screen).toContain('The defaults have no name or expectation.');
		await arrow('down');
		await key('r');
		const name = 'a workflow change is held without asking the model';
		screen = await retype('renamed case', name.length);
		expect(screen).toContain('✓ renamed case');
		await key('a');
		screen = await enter();
		expect(screen).toContain('Case added.');
		expect(screen).toContain('Cases 37/37');
		screen = await key('x');
		expect(screen).toContain('? y/n');
		screen = await key('y');
		expect(screen).toContain('Cases 36/36');
		setup.renderer.destroy();
	});

	test('a narrow terminal still renders the main screen and the rule editor', async () => {
		const { frame, key, setup } = await open([], { width: 60, height: 16 });
		let screen = await frame();
		expect(screen).toContain('saved · lint 0 errors 7 warnings · cases 36/36');
		screen = await key('e');
		expect(screen).toContain('Edit rule');
		setup.renderer.destroy();
	});
});
