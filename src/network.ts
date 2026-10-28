import * as vscode from "vscode";
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";
import { logger } from "./logger";

const proxyAgentCache = new Map<string, Dispatcher>();

/** Reverse lookup: dispatcher instance -> the proxy URL it was built from (for curl logging). */
const dispatcherProxyUrls = new WeakMap<Dispatcher, string>();

/** Header names whose values are masked in the logged curl command.
 * Denylist-by-default: ANY header whose name looks credential-like is masked,
 * so user-defined custom auth headers (e.g. `x-auth-token`, `Helix-Key`)
 * cannot leak into logs. Only known-safe headers pass through unmasked. */
const SAFE_CURL_HEADERS = new Set([
	"accept",
	"accept-encoding",
	"accept-language",
	"anthropic-version",
	"anthropic-beta",
	"cache-control",
	"content-type",
	"content-length",
	"user-agent",
	"host",
	"connection",
]);

/**
 * Max chars of request body / response body to print to the VS Code extension-host
 * console. The console silently DROPS messages above an internal size limit
 * ("Output omitted for a large object that exceeds the limits"), so a curl command
 * embedding a multi-megabyte chat body would never appear. The full, untruncated
 * detail still goes to the file logger (~/.copilot/customcopilot/logs/), which has
 * no such limit.
 */
const CONSOLE_BODY_LIMIT = 4000;

/**
 * Mask the credentials (`user:pass@`) of a proxy URL for display/logging,
 * e.g. `http://bob:s3cret@proxy:8080` → `http://bob:***@proxy:8080`. Values
 * that are not URLs (e.g. `direct`) are returned unchanged.
 */
export function maskProxyCredentials(proxyUrl: string | undefined): string {
	const value = (proxyUrl ?? "").trim();
	if (!value) {
		return "";
	}
	// Regex rather than `new URL()` so unusual schemes (socks5h) and
	// unparsable values are handled and the rest of the string is untouched.
	// Userinfo runs to the LAST "@" of the authority (WHATWG URL / undici read
	// `u:p@ss@host` as password "p@ss"); the authority ends at the first
	// "/", "?" or "#", so an "@" in the path is never mistaken for userinfo.
	const m = /^([a-z][a-z0-9+.-]*:\/\/)(.*)$/is.exec(value);
	if (!m) {
		return value;
	}
	const scheme = m[1];
	const rest = m[2];
	const hostEnd = rest.search(/[/?#]/);
	const authorityAndPath = hostEnd >= 0 ? rest.slice(0, hostEnd) : rest;
	const at = authorityAndPath.lastIndexOf("@");
	if (at < 0) {
		return value;
	}
	const userinfo = authorityAndPath.slice(0, at);
	const sep = userinfo.indexOf(":");
	const user = sep >= 0 ? userinfo.slice(0, sep) : "";
	const masked = sep >= 0 && user ? `${user}:***` : "***";
	return `${scheme}${masked}${rest.slice(at)}`;
}

/** Mask credential-bearing query parameters (e.g. Gemini `?key=`) and userinfo in a logged URL. */
export function maskUrlSecrets(url: string): string {
	return maskProxyCredentials(url).replace(/([?&](?:key|api[_-]?key|access[_-]?token|token)=)[^&#]*/gi, "$1***");
}

/** Whether the user opted into persisting full message content in logs. */
function isLogMessageContentEnabled(): boolean {
	try {
		return vscode.workspace.getConfiguration().get<boolean>("customcopilot.logMessageContent", false) === true;
	} catch {
		return false;
	}
}

function normalizeProxyUrl(proxyUrl?: string): string {
	const value = (proxyUrl || "").trim();
	if (!value) {
		return "";
	}
	const lowerValue = value.toLowerCase();
	if (lowerValue === "none" || lowerValue === "direct" || lowerValue === "no-proxy" || lowerValue === "no_proxy") {
		return "";
	}
	// undici's ProxyAgent only recognises the `socks5:`/`socks:` scheme. It already
	// performs remote DNS for hostnames (SOCKS5 ATYP=DOMAIN), so a `socks5h://`
	// URL (the Tor convention for "resolve at the proxy") is functionally identical.
	// Normalise it to `socks5://` instead of rejecting it, which is a common trap.
	let normalized = value;
	if (/^socks5h:\/\//i.test(value)) {
		normalized = "socks5://" + value.slice("socks5h://".length);
	}
	if (!/^socks5:\/\//i.test(normalized) && !/^https?:\/\//i.test(normalized)) {
		throw new Error("Invalid proxy URL. Use socks5://, socks5h://, http:// or https://");
	}
	return normalized;
}

export function getProxyDispatcher(proxyUrl?: string): Dispatcher | undefined {
	const normalized = normalizeProxyUrl(proxyUrl);
	if (!normalized) {
		return undefined;
	}
	const existing = proxyAgentCache.get(normalized);
	if (existing) {
		return existing;
	}
	const created = new ProxyAgent(normalized);
	proxyAgentCache.set(normalized, created);
	dispatcherProxyUrls.set(created, normalized);
	return created;
}

function isDirectProxyToken(value: string): boolean {
	const v = value.trim().toLowerCase();
	return v === "none" || v === "direct" || v === "no-proxy" || v === "no_proxy";
}

function readGlobalProxyUrl(): string | undefined {
	try {
		const config = vscode.workspace.getConfiguration();
		const globalProxy = config.get<string>("customcopilot.proxyUrl", "").trim();
		if (!globalProxy || isDirectProxyToken(globalProxy)) {
			return undefined;
		}
		return globalProxy;
	} catch {
		return undefined;
	}
}

/** Whether the user enabled detailed curl/response console logging of failed requests. */
function isDebugRequestLoggingEnabled(): boolean {
	try {
		return vscode.workspace.getConfiguration().get<boolean>("customcopilot.debugRequestLogging", false);
	} catch {
		return false;
	}
}

export function buildFetchNetworkInit(proxyUrl?: string): RequestInit {
	let resolved: string | undefined;
	const trimmed = (proxyUrl ?? "").trim();
	if (isDirectProxyToken(trimmed)) {
		// Explicit opt-out: force a direct connection, ignoring the global proxy.
		resolved = undefined;
	} else if (trimmed) {
		// A concrete per-call proxy was provided.
		resolved = trimmed;
	} else {
		// Not specified (undefined or blank): fall back to the global proxy config.
		resolved = readGlobalProxyUrl();
	}

	const dispatcher = getProxyDispatcher(resolved);
	if (!dispatcher) {
		return {};
	}
	return { dispatcher } as RequestInit;
}

/**
 * Normalise a fetch `headers` init value into a plain `[name, value]` array.
 * Supports `Headers`, `[string, string][]`, and `Record<string, string>`.
 */
function headerEntries(headers: unknown): [string, string][] {
	if (!headers) {
		return [];
	}
	// Headers / undici Headers expose forEach + entries.
	if (typeof (headers as Headers).forEach === "function") {
		const out: [string, string][] = [];
		(headers as Headers).forEach((value, key) => out.push([key, value]));
		return out;
	}
	if (Array.isArray(headers)) {
		return (headers as [string, string][]).map(([k, v]) => [String(k), String(v)]);
	}
	return Object.entries(headers as Record<string, string>).map(([k, v]) => [k, String(v)]);
}

/** Mask the value of any header not on the known-safe allowlist (see above). */
function maskHeaderValue(name: string, value: string): string {
	if (SAFE_CURL_HEADERS.has(name.toLowerCase())) {
		return value;
	}
	const prefix = value.startsWith("Bearer ") ? "Bearer " : "";
	const token = prefix ? value.slice(prefix.length) : value;
	if (token.length <= 4) {
		return prefix + "***";
	}
	return prefix + token.slice(0, 4) + "***";
}

/** Single-quote a string for safe embedding in a shell (curl) command. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Truncate a long string to `max` characters, appending a marker that records
 * the original length. Keeps log/console output below the extension-host
 * console size limit (which otherwise drops the whole message as "Output
 * omitted for a large object that exceeds the limits").
 */
function truncate(value: string, max: number): string {
	if (value.length <= max) {
		return value;
	}
	return `${value.slice(0, max)}… [truncated, ${value.length} chars total]`;
}

/**
 * Build a copy-pasteable `curl` command that reproduces the given request.
 * Sensitive header values are masked; the proxy (if any) is included via `-x`.
 * The request body is truncated to `maxBodyChars` so the command stays within
 * console/log size limits (pass `Infinity` to keep the full body).
 */
function buildCurlCommand(
	input: string | URL | Request,
	init: (RequestInit & { dispatcher?: Dispatcher }) | undefined,
	proxyUrl: string | undefined,
	maxBodyChars: number
): string {
	const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
	const method = (init?.method || (input instanceof Request ? input.method : undefined) || "GET").toUpperCase();

	const parts = ["curl"];
	if (method !== "GET") {
		parts.push("-X", method);
	}
	if (proxyUrl) {
		parts.push("-x", shellQuote(maskProxyCredentials(proxyUrl)));
	}

	for (const [name, value] of headerEntries(init?.headers)) {
		parts.push("-H", shellQuote(`${name}: ${maskHeaderValue(name, value)}`));
	}

	const body = init?.body;
	if (typeof body === "string" && body.length > 0) {
		parts.push("--data-raw", shellQuote(truncate(body, maxBodyChars)));
	} else if (body != null && typeof body !== "string") {
		// Non-string bodies (streams, buffers, form data) cannot be reproduced verbatim.
		parts.push("--data-raw", shellQuote("<non-string body omitted>"));
	}

	parts.push(shellQuote(maskUrlSecrets(url)));
	return parts.join(" ");
}

/** Byte/char length of a request body, when it is a string (0 otherwise). */
function bodyLength(init: (RequestInit & { dispatcher?: Dispatcher }) | undefined): number {
	const body = init?.body;
	return typeof body === "string" ? body.length : 0;
}

/**
 * Fetch that actually honours the per-request `dispatcher` (ProxyAgent).
 *
 * IMPORTANT: VS Code's extension host REPLACES `globalThis.fetch` with its own
 * wrapper (see `vs/workbench/api/node/proxyResolver.ts → patchGlobalFetch`).
 * That wrapper routes through VS Code's own `http.proxy`/`http.proxySupport`
 * settings and SILENTLY DROPS the undici `dispatcher` option we attach in
 * `buildFetchNetworkInit`. As a result, a socks5 proxy configured in
 * `customcopilot.proxyUrl` (or per-model `proxyUrl`) is ignored and every
 * request goes direct / via VS Code's proxy — the "proxy not recognised" bug.
 *
 * Calling undici's own `fetch` directly bypasses the patched global, so the
 * `dispatcher` is respected and socks5/http/https proxies work for ALL of a
 * provider's requests (model discovery, chat, commit generation, key tests).
 *
 * The returned object is structurally a standard `Response` (`.ok`, `.status`,
 * `.statusText`, `.text()`, `.json()`, `.body` ReadableStream) — undici's
 * Response implements the web spec, so existing call sites work unchanged.
 *
 * On a failed request (network exception OR a non-2xx HTTP response) it logs a
 * reproducible `curl` command and the server's response body to the VS Code
 * console (and the file logger) so the failure can be debugged easily. This
 * verbose logging only happens when `customcopilot.debugRequestLogging` is on.
 */
export async function proxyFetch(
	input: string | URL | Request,
	init?: RequestInit & { dispatcher?: Dispatcher }
): Promise<Response> {
	const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
	const url = maskUrlSecrets(rawUrl);
	const method = (init?.method || (input instanceof Request ? input.method : undefined) || "GET").toUpperCase();
	const proxyUrl = dispatcherProxyUrls.get(init?.dispatcher as Dispatcher);
	const debug = isDebugRequestLoggingEnabled();
	// The request body carries the conversation: only persist it in full when
	// the user explicitly opted into logging message content.
	const fileBodyLimit = isLogMessageContentEnabled() ? Infinity : CONSOLE_BODY_LIMIT;

	try {
		// Cast through unknown: undici's RequestInit/Response types differ slightly
		// from the DOM lib types, but the runtime shapes are compatible.
		const response = (await undiciFetch(
			input as Parameters<typeof undiciFetch>[0],
			init as Parameters<typeof undiciFetch>[1]
		)) as unknown as Response;

		if (!response.ok && debug) {
			// Full body for the file logger; truncated for the console (size-limited).
			const reqLen = bodyLength(init);
			const curlConsole = buildCurlCommand(input, init, proxyUrl, CONSOLE_BODY_LIMIT);
			const curlFull = buildCurlCommand(input, init, proxyUrl, fileBodyLimit);
			// Read the error body from a CLONE so the original response stays consumable
			// by the caller (which typically reads `.text()`/`.json()`/`.body` itself).
			let responseBody = "";
			try {
				responseBody = await response.clone().text();
			} catch {
				responseBody = "<unable to read response body>";
			}
			console.error(
				`[customcopilot] Request failed: ${method} ${url} -> [${response.status}] ${response.statusText}` +
					` (request body ${reqLen} chars)\n` +
					`--- curl ---\n${curlConsole}\n--- response ---\n${truncate(responseBody, CONSOLE_BODY_LIMIT)}`
			);
			logger.error("request.failed", {
				method,
				url,
				status: response.status,
				statusText: response.statusText,
				requestBodyLength: reqLen,
				curl: curlFull,
				response: truncate(responseBody, fileBodyLimit),
			});
		}

		return response;
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		if (debug) {
			const reqLen = bodyLength(init);
			const curlConsole = buildCurlCommand(input, init, proxyUrl, CONSOLE_BODY_LIMIT);
			const curlFull = buildCurlCommand(input, init, proxyUrl, fileBodyLimit);
			console.error(
				`[customcopilot] Request error: ${method} ${url} -> ${message}` +
					` (request body ${reqLen} chars)\n--- curl ---\n${curlConsole}`
			);
			logger.error("request.error", { method, url, error: message, requestBodyLength: reqLen, curl: curlFull });
		}
		throw e;
	}
}
