import type { OpenAPIServer, ParameterLocation } from '../types';

export interface StyleOptions {
	style?: string;
	explode?: boolean;
	allowReserved?: boolean;
}

/** OpenAPI defaults differ per location */
export function defaultStyle(location: ParameterLocation): string {
	return location === 'query' || location === 'cookie' ? 'form' : 'simple';
}

export function defaultExplode(style: string): boolean {
	return style === 'form' || style === 'deepObject';
}

function isPlain(value: unknown): boolean {
	return value === null || ['string', 'number', 'boolean', 'bigint'].includes(typeof value);
}

function str(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'bigint') {
		return String(value);
	}
	return JSON.stringify(value);
}

function enc(value: string, allowReserved: boolean): string {
	if (!allowReserved) return encodeURIComponent(value);
	// reserved set stays literal; everything else still needs escaping
	return encodeURI(value).replace(/%25/g, '%25');
}

function entriesOf(value: object): [string, unknown][] {
	return Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
}

/**
 * Serializes one query parameter into `name=value` pairs.
 * Implements form, spaceDelimited, pipeDelimited and deepObject per OpenAPI 3.x.
 */
export function serializeQueryParam(
	name: string,
	value: unknown,
	opts: StyleOptions = {}
): string[] {
	if (value === undefined) return [];

	const style = opts.style || 'form';
	const explode = opts.explode ?? defaultExplode(style);
	const reserved = opts.allowReserved === true;
	const key = enc(name, false);

	if (value === null) return [`${key}=`];

	if (Array.isArray(value)) {
		const parts = value.filter((v) => v !== undefined).map((v) => str(v));
		if (parts.length === 0) return [];

		if (style === 'deepObject') {
			return parts.map((v, i) => `${key}%5B${i}%5D=${enc(v, reserved)}`);
		}
		if (explode) return parts.map((v) => `${key}=${enc(v, reserved)}`);

		const sep = style === 'spaceDelimited' ? '%20' : style === 'pipeDelimited' ? '%7C' : ',';
		return [`${key}=${parts.map((v) => enc(v, reserved)).join(sep)}`];
	}

	if (typeof value === 'object') {
		const pairs = entriesOf(value);
		if (pairs.length === 0) return [];

		if (style === 'deepObject') {
			return pairs.map(([k, v]) => `${key}%5B${enc(k, false)}%5D=${enc(str(v), reserved)}`);
		}
		if (explode) return pairs.map(([k, v]) => `${enc(k, false)}=${enc(str(v), reserved)}`);

		const flat = pairs.flatMap(([k, v]) => [k, str(v)]);
		return [`${key}=${flat.map((v) => enc(v, reserved)).join(',')}`];
	}

	return [`${key}=${enc(str(value), reserved)}`];
}

/** Serializes one path parameter, including the structural prefix for label and matrix. */
export function serializePathParam(name: string, value: unknown, opts: StyleOptions = {}): string {
	const style = opts.style || 'simple';
	const explode = opts.explode ?? defaultExplode(style);
	const e = (v: unknown) => encodeURIComponent(str(v));

	if (value === undefined || value === null) {
		if (style === 'label') return '.';
		if (style === 'matrix') return `;${name}=`;
		return '';
	}

	if (Array.isArray(value)) {
		const parts = value.filter((v) => v !== undefined).map(e);
		switch (style) {
			case 'label':
				return explode ? `.${parts.join('.')}` : `.${parts.join(',')}`;
			case 'matrix':
				return explode ? parts.map((v) => `;${name}=${v}`).join('') : `;${name}=${parts.join(',')}`;
			default:
				return parts.join(',');
		}
	}

	if (typeof value === 'object') {
		const pairs = entriesOf(value);
		switch (style) {
			case 'label':
				return explode
					? `.${pairs.map(([k, v]) => `${k}=${e(v)}`).join('.')}`
					: `.${pairs.flatMap(([k, v]) => [k, e(v)]).join(',')}`;
			case 'matrix':
				return explode
					? pairs.map(([k, v]) => `;${k}=${e(v)}`).join('')
					: `;${name}=${pairs.flatMap(([k, v]) => [k, e(v)]).join(',')}`;
			default:
				return explode
					? pairs.map(([k, v]) => `${k}=${e(v)}`).join(',')
					: pairs.flatMap(([k, v]) => [k, e(v)]).join(',');
		}
	}

	const single = e(value);
	if (style === 'label') return `.${single}`;
	if (style === 'matrix') return `;${name}=${single}`;
	return single;
}

/** Header and cookie values are `simple`/`form` style and are never percent-encoded here. */
export function serializeHeaderParam(value: unknown, opts: StyleOptions = {}): string {
	const explode = opts.explode ?? false;

	if (Array.isArray(value))
		return value
			.filter((v) => v !== undefined)
			.map(str)
			.join(',');
	if (value !== null && typeof value === 'object') {
		const pairs = entriesOf(value);
		return explode
			? pairs.map(([k, v]) => `${k}=${str(v)}`).join(',')
			: pairs.flatMap(([k, v]) => [k, str(v)]).join(',');
	}
	return str(value);
}

/**
 * Substitutes `{name}` placeholders, replacing **every** occurrence rather than the first.
 * A repeated placeholder in one path is legal and used in real specs.
 */
export function applyPathTemplate(path: string, values: Map<string, string>): string {
	return path.replace(/\{([^}]+)\}/g, (match, rawName: string) => {
		const name = rawName.trim();
		const value = values.get(name);
		return value === undefined ? match : value;
	});
}

/**
 * Resolves an OpenAPI server URL, substituting `{variable}` from defaults or overrides.
 * A variable with no default and no override is left as-is so the failure is visible.
 */
export function resolveServerUrl(
	server: OpenAPIServer,
	overrides: Record<string, string> = {}
): string {
	if (!server.variables) return server.url;

	return server.url.replace(/\{([^}]+)\}/g, (match, rawName: string) => {
		const name = rawName.trim();
		const override = overrides[name];
		if (override !== undefined) return override;

		const variable = server.variables?.[name];
		if (variable?.default !== undefined) return variable.default;
		if (variable?.enum?.[0] !== undefined) return variable.enum[0];
		return match;
	});
}

/** Joins a base URL and a path without doubling or dropping the separating slash. */
export function joinUrl(base: string, path: string): string {
	const trimmedBase = base.endsWith('/') ? base.slice(0, -1) : base;
	if (path === '') return trimmedBase;
	const normalizedPath = path.startsWith('/') || path.startsWith(';') ? path : `/${path}`;
	return `${trimmedBase}${normalizedPath}`;
}

export { isPlain, str as stringifyValue };
