import type { KeyEvent, MouseEvent } from '@opentui/core';

import { COLORS, CloseRow, visibleWindow, type Line } from './views';

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

type Picker = Extract<Overlay, { kind: 'picker' }>;
type SetOverlay = (next: Overlay | null) => void;

function stepPicker(overlay: Picker, direction: -1 | 1): Picker {
	const count = overlay.options.length;
	if (count === 0) return overlay;
	return { ...overlay, index: (overlay.index + (direction < 0 ? count - 1 : 1)) % count };
}

/** Chooses the option at `index`. A multi-select toggles it. A typed option asks for text. */
function chooseOption(overlay: Picker, index: number, set: SetOverlay, invalid: (message: string) => void): void {
	const option = overlay.options[index];
	if (!option) return;
	if (overlay.multi) {
		const chosen = new Set(overlay.chosen);
		if (chosen.has(index)) chosen.delete(index);
		else chosen.add(index);
		set({ ...overlay, index, chosen });
		return;
	}
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
	overlay.pick([option.value]);
}

/**
 * Handles a key while an overlay is open. A prompt's own input handles typing
 * and enter, so only escape reaches here for it.
 */
export function overlayKey(key: KeyEvent, overlay: Overlay, set: SetOverlay, invalid: (message: string) => void): void {
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
	if (key.name === 'up' || key.name === 'down') {
		set(stepPicker(overlay, key.name === 'up' ? -1 : 1));
	} else if (key.name === 'space' && overlay.multi) {
		chooseOption(overlay, overlay.index, set, invalid);
	} else if (key.name === 'return') {
		if (overlay.multi) {
			set(null);
			overlay.pick([...overlay.chosen].sort((a, b) => a - b).map((i) => overlay.options[i]!.value));
			return;
		}
		chooseOption(overlay, overlay.index, set, invalid);
	}
}

export function OverlayBox(props: { overlay: Overlay; width: number; height: number; set: SetOverlay; invalid: (message: string) => void }) {
	const { overlay } = props;
	const boxWidth = Math.min(props.width - 4, 100);
	const lines = overlay.kind === 'help' || overlay.kind === 'confirm' ? overlay.lines : [];
	const options = overlay.kind === 'picker' ? overlay.options : [];
	const confirmActions = overlay.kind === 'confirm' ? 2 : 0;
	const foot = confirmActions + 1;
	const bodyLimit = Math.max(1, props.height - 6 - foot);
	const body =
		overlay.kind === 'picker' ? Math.min(Math.max(options.length, 1), bodyLimit) : overlay.kind === 'prompt' ? 1 : Math.min(Math.max(1, lines.length), bodyLimit);
	const rows = body + foot;
	const [start, end] = overlay.kind === 'picker' ? visibleWindow(options.length, overlay.index, body) : [0, body];

	function onScroll(event: MouseEvent) {
		if (overlay.kind !== 'picker') return;
		const direction = event.scroll?.direction === 'up' ? -1 : event.scroll?.direction === 'down' ? 1 : 0;
		if (!direction) return;
		event.stopPropagation();
		props.set(stepPicker(overlay, direction));
	}

	function close(event: MouseEvent) {
		if (event.button !== 0) return;
		event.stopPropagation();
		props.set(null);
	}

	const dismiss = () => props.set(null);

	return (
		<box
			title={` ${overlay.title} `}
			onMouseDown={(event) => {
				event.stopPropagation();
				if (overlay.kind === 'help') props.set(null);
			}}
			onMouseScroll={onScroll}
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
			<CloseRow onClose={dismiss} />
			{overlay.kind === 'prompt' ? (
				<input
					// A new key for each prompt, so a prompt that follows another starts empty instead of
					// reusing the text typed into the first one.
					key={`${overlay.title}\u0000${overlay.initial}`}
					focused
					value={overlay.initial}
					onSubmit={(text) => {
						props.set(null);
						overlay.submit(typeof text === 'string' ? text : '');
					}}
				/>
			) : overlay.kind === 'picker' ? (
				options.slice(start, end).map((option, i) => {
					const at = start + i;
					const mark = overlay.multi ? (overlay.chosen.has(at) ? '[x] ' : '[ ] ') : '';
					return (
						<text
							key={at}
							wrapMode="none"
							truncate
							selectable={false}
							style={{ width: '100%' }}
							fg={option.typed ? COLORS.dim : COLORS.text}
							bg={at === overlay.index ? COLORS.selected : undefined}
							onMouseDown={(event) => {
								if (event.button !== 0) return;
								event.stopPropagation();
								chooseOption(overlay, at, props.set, props.invalid);
							}}
						>
							{`${mark}${option.label}`}
						</text>
					);
				})
			) : (
				<>
					{(lines.length > 0 ? lines : [{ text: overlay.kind === 'confirm' ? 'Click y or n, or [esc to close].' : '' }]).slice(start, end).map((line, i) => (
						<text key={i} wrapMode="none" truncate selectable={false} fg={COLORS[line.tone ?? 'text']}>
							{line.text}
						</text>
					))}
					{overlay.kind === 'confirm' ? (
						<>
							<text
								wrapMode="none"
								truncate
								selectable={false}
								style={{ width: '100%' }}
								fg={COLORS.open}
								onMouseDown={(event) => {
									if (event.button !== 0) return;
									event.stopPropagation();
									props.set(null);
									overlay.yes();
								}}
							>
								y  yes
							</text>
							<text
								wrapMode="none"
								truncate
								selectable={false}
								style={{ width: '100%' }}
								fg={COLORS.dim}
								onMouseDown={close}
							>
								n  no
							</text>
						</>
					) : null}
				</>
			)}
		</box>
	);
}
