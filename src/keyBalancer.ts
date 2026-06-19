import { createHash } from "crypto";
import type * as vscode from "vscode";
import { logger } from "./logger";

/**
 * Per-key health state used to balance requests across multiple API keys.
 */
interface KeyState {
	/** Accumulated error score (decays over time and on success). */
	errors: number;
	/** Timestamp (ms) of the last recorded error, used for decay. */
	lastErrorAt: number;
	/** While `Date.now()` is below this value the key is benched. */
	cooldownUntil: number;
}

/**
 * Cumulative, persisted usage counters for a single key (keyed by a hash of the
 * key so the raw secret is never written to globalState). Surfaced in the
 * configuration UI as a per-key health table.
 */
interface KeyStat {
	requests: number;
	errors: number;
	lastError?: string;
	lastErrorAt?: number;
}

interface ProviderState {
	states: Map<string, KeyState>;
	/** Round-robin cursor shared across concurrent requests for this provider. */
	cursor: number;
}

// One error is forgiven every DECAY_INTERVAL_MS so benched keys recover.
const DECAY_INTERVAL_MS = 15000;
// A key whose error score exceeds the current minimum by more than this is excluded.
const BENCH_THRESHOLD = 2;
// Hitting this error score benches the key for COOLDOWN_MS.
const BENCH_ERROR_LIMIT = 5;
const COOLDOWN_MS = 30000;
// A fatal key error (quota exhausted / bad key) benches it for much longer so
// the balancer stops trying it within the same and subsequent requests.
const FATAL_COOLDOWN_MS = 5 * 60 * 1000;
// A successful request forgives this many accumulated errors.
const SUCCESS_RECOVERY = 2;

const STATS_STORAGE_KEY = "customcopilot.keyStats";

/** Mask an API key for display: keep the head and tail, hide the middle. */
export function maskApiKey(key: string): string {
	const k = (key || "").trim();
	if (!k) {
		return "";
	}
	if (k.length <= 8) {
		return `${k.slice(0, 2)}${"•".repeat(Math.max(1, k.length - 2))}`;
	}
	return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

/**
 * Balances requests across a pool of API keys for a single logical provider.
 *
 * Selection prefers the healthiest keys (fewest recent errors) and round-robins
 * among keys of comparable health so load is spread evenly. Keys that accumulate
 * many errors are temporarily benched until their error score decays below the
 * others. The balancer is concurrency-safe for the simple round-robin/score model
 * because all mutation happens synchronously inside its methods.
 */
class KeyBalancer {
	private readonly providers = new Map<string, ProviderState>();
	/** Cumulative per-key counters keyed by `${provider}::${hash(key)}`. */
	private readonly stats = new Map<string, KeyStat>();
	private context?: vscode.ExtensionContext;
	private saveTimer?: ReturnType<typeof setTimeout>;

	/**
	 * Wire persistence so per-key usage counters survive reloads. Stats are
	 * stored keyed by a hash of the key, so the raw secret is never persisted.
	 */
	public init(context: vscode.ExtensionContext): void {
		this.context = context;
		const saved = context.globalState.get<Record<string, KeyStat>>(STATS_STORAGE_KEY);
		if (saved) {
			for (const [id, value] of Object.entries(saved)) {
				this.stats.set(id, {
					requests: value.requests ?? 0,
					errors: value.errors ?? 0,
					lastError: value.lastError,
					lastErrorAt: value.lastErrorAt,
				});
			}
		}
	}

	private statId(provider: string, key: string): string {
		const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
		return `${provider}::${hash}`;
	}

	private getStat(provider: string, key: string): KeyStat {
		const id = this.statId(provider, key);
		let stat = this.stats.get(id);
		if (!stat) {
			stat = { requests: 0, errors: 0 };
			this.stats.set(id, stat);
		}
		return stat;
	}

	private scheduleSave(): void {
		if (!this.context || this.saveTimer) {
			return;
		}
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			if (!this.context) {
				return;
			}
			const obj: Record<string, KeyStat> = {};
			for (const [id, value] of this.stats) {
				obj[id] = value;
			}
			void this.context.globalState.update(STATS_STORAGE_KEY, obj);
		}, 1000);
	}

	private getProvider(provider: string): ProviderState {
		let state = this.providers.get(provider);
		if (!state) {
			state = { states: new Map<string, KeyState>(), cursor: 0 };
			this.providers.set(provider, state);
		}
		return state;
	}

	private getKeyState(providerState: ProviderState, key: string): KeyState {
		let state = providerState.states.get(key);
		if (!state) {
			state = { errors: 0, lastErrorAt: 0, cooldownUntil: 0 };
			providerState.states.set(key, state);
		}
		return state;
	}

	/** Forgive accumulated errors based on elapsed time since the last error. */
	private decay(state: KeyState, now: number): void {
		if (state.errors <= 0 || state.lastErrorAt <= 0) {
			return;
		}
		const steps = Math.floor((now - state.lastErrorAt) / DECAY_INTERVAL_MS);
		if (steps > 0) {
			state.errors = Math.max(0, state.errors - steps);
			state.lastErrorAt = now;
			if (state.errors === 0) {
				state.cooldownUntil = 0;
			}
		}
	}

	/**
	 * Select the next key to use from the provided pool.
	 * @param provider Normalized provider id (lowercase).
	 * @param keys The available API keys for this provider.
	 * @param exclude Keys already tried in the current request; avoided while
	 *                any untried keys remain so each attempt uses a fresh key.
	 * @returns The chosen key, or an empty string when the pool is empty.
	 */
	public selectKey(provider: string, keys: string[], exclude?: ReadonlySet<string>): string {
		if (keys.length === 0) {
			return "";
		}

		// Prefer keys not yet tried in the current request so retries rotate to a
		// fresh key before reusing an already-failed one.
		let pool = keys;
		if (exclude && exclude.size > 0) {
			const remaining = keys.filter((key) => !exclude.has(key));
			if (remaining.length > 0) {
				pool = remaining;
			}
		}

		if (pool.length === 1) {
			return pool[0];
		}

		const providerState = this.getProvider(provider);
		const now = Date.now();

		// Refresh decay for every key in the pool.
		for (const key of pool) {
			this.decay(this.getKeyState(providerState, key), now);
		}

		const minErrors = Math.min(...pool.map((key) => this.getKeyState(providerState, key).errors));

		// Healthy candidates: not benched and within BENCH_THRESHOLD of the best key.
		let candidates = pool.filter((key) => {
			const state = this.getKeyState(providerState, key);
			return state.cooldownUntil <= now && state.errors <= minErrors + BENCH_THRESHOLD;
		});

		// If everything is benched, fall back to the keys with the fewest errors.
		if (candidates.length === 0) {
			candidates = pool.filter((key) => this.getKeyState(providerState, key).errors === minErrors);
		}
		if (candidates.length === 0) {
			candidates = pool;
		}

		const index = providerState.cursor % candidates.length;
		providerState.cursor = (providerState.cursor + 1) % Number.MAX_SAFE_INTEGER;
		return candidates[index];
	}

	/** Count an attempt against a key (cumulative, persisted for the UI). */
	public recordRequest(provider: string, key: string): void {
		if (!key) {
			return;
		}
		const stat = this.getStat(provider, key);
		stat.requests += 1;
		this.scheduleSave();
	}

	/**
	 * Per-key health snapshot for the configuration UI, ordered to match `keys`.
	 * Keys are returned masked so the raw secret never leaves the extension host.
	 */
	public getStats(
		provider: string,
		keys: string[]
	): Array<{
		keyMasked: string;
		requests: number;
		errors: number;
		benched: boolean;
		lastError?: string;
		lastErrorAt?: number;
	}> {
		const providerState = this.providers.get(provider);
		const now = Date.now();
		return keys.map((key) => {
			const stat = this.getStat(provider, key);
			const health = providerState?.states.get(key);
			return {
				keyMasked: maskApiKey(key),
				requests: stat.requests,
				errors: stat.errors,
				benched: !!health && health.cooldownUntil > now,
				lastError: stat.lastError,
				lastErrorAt: stat.lastErrorAt,
			};
		});
	}

	/** Record a failed request for a key, benching it once it gets too unhealthy. */
	public reportError(provider: string, key: string, opts?: { fatal?: boolean; message?: string }): void {
		if (!key) {
			return;
		}
		const providerState = this.getProvider(provider);
		const state = this.getKeyState(providerState, key);
		const now = Date.now();
		// A fatal error (quota exhausted / invalid key) pushes the score past the
		// bench limit immediately so the key is taken out of rotation at once.
		state.errors += opts?.fatal ? BENCH_ERROR_LIMIT : 1;
		state.lastErrorAt = now;
		if (opts?.fatal) {
			state.cooldownUntil = now + FATAL_COOLDOWN_MS;
		} else if (state.errors >= BENCH_ERROR_LIMIT) {
			state.cooldownUntil = now + COOLDOWN_MS;
		}

		const stat = this.getStat(provider, key);
		stat.errors += 1;
		stat.lastErrorAt = now;
		if (opts?.message) {
			stat.lastError = opts.message;
		}
		this.scheduleSave();

		logger.debug("keyBalancer.error", {
			provider,
			errors: state.errors,
			fatal: !!opts?.fatal,
			benched: state.cooldownUntil > now,
		});
	}

	/** Record a successful request for a key, recovering part of its error score. */
	public reportSuccess(provider: string, key: string): void {
		if (!key) {
			return;
		}
		const providerState = this.getProvider(provider);
		const state = this.getKeyState(providerState, key);
		if (state.errors > 0) {
			state.errors = Math.max(0, state.errors - SUCCESS_RECOVERY);
		}
		if (state.errors === 0) {
			state.cooldownUntil = 0;
		}
	}
}

export const keyBalancer = new KeyBalancer();

/**
 * Parse a stored secret value into a list of distinct API keys.
 * Keys may be separated by newlines (preferred), or commas. A single key
 * (the legacy format) yields a one-element array, preserving backward
 * compatibility.
 */
export function parseApiKeys(secretValue: string | undefined | null): string[] {
	if (!secretValue) {
		return [];
	}
	const seen = new Set<string>();
	const keys: string[] = [];
	for (const raw of secretValue.split(/[\r\n,]+/)) {
		const key = raw.trim();
		if (key && !seen.has(key)) {
			seen.add(key);
			keys.push(key);
		}
	}
	return keys;
}
