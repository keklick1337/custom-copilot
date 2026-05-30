import * as vscode from "vscode";

export class VersionManager {
	private static _version: string | null = null;

	/**
	 * Get the current extension version
	 */
	static getVersion(): string {
		if (this._version === null) {
			const extension = vscode.extensions.getExtension("keklick1337.keklick-copilot");
			this._version = extension?.packageJSON?.version ?? "unknown";
		}
		return this._version!;
	}

	/**
	 * Build a descriptive User-Agent to help quantify API usage
	 * Keep UA minimal: only extension version and VS Code version
	 */
	static getUserAgent(): string {
		const config = vscode.workspace.getConfiguration();
		return config.get<string>(
			"customcopilot.userAgent",
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
		);
	}

	/**
	 * Get the current extension information
	 */
	static getClientInfo(): { name: string; version: string; author: string } {
		return {
			name: "keklick-copilot",
			version: this.getVersion(),
			author: "keklick1337",
		};
	}
}
