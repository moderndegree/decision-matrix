import type { KeyEvent } from '@opentui/core';

import { COLORS, visibleWindow, type Line } from './views';

/**
 * The small windows every screen shares: a list to pick from, a line of text
 * to type, a yes/no question, and help. Each screen keeps one Overlay in its
 * state, renders it with OverlayBox, and routes keys to overlayKey while it is
 * open.
 */

export interface Option {
	label: string;
	value: unknown;
	/** Asks for typed input instead of choosing this value. Return undefined to reject the text. */
	typed?: { title: string; initial: string; parse: (text: string) => unknown };
}

export type Overlay =
	| { kind: 'picker'; title: string; options: Option[]; index: number; multi: boolean; chosen: Set<number>; pick: (values: unknown[]) => void }
	| { kind: 'prompt'; title: string; initial: string; submit: (text: string) => void }
	| { kind: 'confirm'; title: string; lines: Line[]; yes: () => void }
	| { kind: 'help'; title: string; lines: Line[] };

export function picker(title: string, options: Option[], pick: (value: unknown) => void, current?: unknown): Overlay {
	const index = Math.max(0, options.findIndex((option) => !option.typed && JSON.stringify(option.value) === JSON.stringify(current)));
	return { kind: 'picker', title, options, index, multi: false, chosen: new Set(), pick: ([value]) => pick(value) };
}

export function multiPicker(title: string, options: Option[], chosen: number[], pick: (values: unknown[]) => void): Overlay {
	return { kind: 'picker', title, options, index: Math.max(0, chosen[0] ?? 0), multi: true, chosen: new Set(chosen), pick };
}

/**
 * Handles a key while an overlay is open. A prompt's own input handles typing
 * and enter, so only escape reaches here for it.
 */
export function overlayKey(key: KeyEvent, overlay: Overlay, set: (next: Overlay | null) => void, invalid: (message: string) => void): void {
	if (overlay.kind === 'help') return set(null);
	if (key.name === 'escape') return set(null);
	if (overlay.kind === 'confirm') {
		if (key.name === 'y') {
			set(null);
			overlay.yes();
		} else if (key.name === 'n') set(null);
		return;
	}
	if (overlay.kind !== 'picker') return;
	const count = overlay.options.length;
	if (key.name === 'up' || key.name === 'down') {
		set({ ...overlay, index: (overlay.index + (key.name === 'up' ? count - 1 : 1)) % count });
	} else if (key.name === 'space' && overlay.multi) {
		const chosen = new Set(overlay.chosen);
		if (chosen.has(overlay.index)) chosen.delete(overlay.index);
		else chosen.add(overlay.index);
		set({ ...overlay, chosen });
	} else if (key.name === 'return') {
		const option = overlay.options[overlay.index]!;
		if (option.typed) {
			const typed = option.typed;
			set({
				kind: 'prompt',
				title: typed.title,
				initial: typed.initial,
				submit: (text) => {
					const parsed = typed.parse(text);
					if (parsed === undefined) invalid('That is not a valid value.');
					else overlay.pick([parsed]);
				},
			});
			return;
		}
		set(null);
		overlay.pick(overlay.multi ? [...overlay.chosen].sort((a, b) => a - b).map((i) => overlay.options[i]!.value) : [option.value]);
	}
}

export function OverlayBox(props: { overlay: Overlay; width: number; height: number; close: () => void }) {
	const { overlay } = props;
	const boxWidth = Math.min(props.width - 4, 100);
	const lines = overlay.kind === 'help' || overlay.kind === 'confirm' ? overlay.lines : [];
	const options = overlay.kind === 'picker' ? overlay.options : [];
	const rows =
		overlay.kind === 'picker'
			? Math.min(options.length, props.height - 6)
			: overlay.kind === 'prompt'
				? 1
				: Math.min(Math.max(1, lines.length), props.height - 6);
	const [start, end] = overlay.kind === 'picker' ? visibleWindow(options.length, overlay.index, rows) : [0, rows];
	return (
		<box
			title={` ${overlay.title} `}
			style={{
				position: 'absolute',
				left: Math.floor((props.width - boxWidth) / 2),
				top: Math.max(1, Math.floor((props.height - rows - 2) / 3)),
				width: boxWidth,
				height: rows + 2,
				border: true,
				borderColor: COLORS.focus,
				backgroundColor: '#16161e',
				flexDirection: 'column',
				paddingLeft: 1,
				paddingRight: 1,
			}}
		>
			{overlay.kind === 'prompt' ? (
				<input
					// A new key for each prompt, so a prompt that follows another starts empty instead of
					// reusing the text typed into the first one.
					key={`${overlay.title}\u0000${overlay.initial}`}
					focused
					value={overlay.initial}
					onSubmit={(text) => {
						props.close();
						overlay.submit(typeof text === 'string' ? text : '');
					}}
				/>
			) : overlay.kind === 'picker' ? (
				options.slice(start, end).map((option, i) => {
					const at = start + i;
					const mark = overlay.multi ? (overlay.chosen.has(at) ? '[x] ' : '[ ] ') : '';
					return (
						<text key={at} wrapMode="none" truncate fg={option.typed ? COLORS.dim : COLORS.text} bg={at === overlay.index ? COLORS.selected : undefined}>
							{`${mark}${option.label}`}
						</text>
					);
				})
			) : (
				(lines.length > 0 ? lines : [{ text: 'Press y or n.' }]).slice(start, end).map((line, i) => (
					<text key={i} wrapMode="none" truncate fg={COLORS[line.tone ?? 'text']}>
						{line.text}
					</text>
				))
			)}
		</box>
	);
}
