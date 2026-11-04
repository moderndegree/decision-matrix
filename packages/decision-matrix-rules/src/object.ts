/** Plain JSON objects only. Arrays, dates, and class instances are rejected. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export function describeValue(value: unknown): string {
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	if (Array.isArray(value)) return 'an array';
	if (typeof value === 'string') return 'a string';
	if (typeof value === 'number') return 'a number';
	if (typeof value === 'boolean') return 'a boolean';
	return typeof value;
}
