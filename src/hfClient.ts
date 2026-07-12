import { requestUrl, RequestUrlParam } from "obsidian";

export interface RemoteEntry {
	path: string;
	size: number;
	oid: string; // git blob sha (or xet hash) as reported by the Hub - used only
	// as an opaque "did this change" marker, never recomputed locally.
}

export class HFError extends Error {
	status?: number;
	constructor(message: string, status?: number) {
		super(message);
		this.status = status;
	}
}

/**
 * Thin client around the Hugging Face Hub HTTP API, used against a private
 * dataset repo acting as the sync "bucket". Only plain HTTPS endpoints are
 * used (tree listing, resolve/download, and the NDJSON commit endpoint) so
 * this works identically on desktop and mobile Obsidian.
 */
export class HFClient {
	token: string;
	repoId: string; // "owner/name"
	revision: string;
	repoType: "datasets" = "datasets";

	constructor(token: string, repoId: string, revision = "main") {
		this.token = token.trim();
		this.repoId = repoId.trim().replace(/^\/+|\/+$/g, "");
		this.revision = revision;
	}

	private authHeaders(extra: Record<string, string> = {}) {
		return {
			Authorization: `Bearer ${this.token}`,
			...extra,
		};
	}

	private async req(params: RequestUrlParam): Promise<{ status: number; text: string; json: any; arrayBuffer: ArrayBuffer }> {
		try {
			const res = await requestUrl({ ...params, throw: false });
			let json: any = undefined;
			try {
				json = res.json;
			} catch {
				/* not json, ignore */
			}
			return { status: res.status, text: res.text, json, arrayBuffer: res.arrayBuffer };
		} catch (e: any) {
			throw new HFError(`Network error contacting Hugging Face: ${e?.message ?? e}`);
		}
	}

	/** Validates the token and returns the HF username, or throws. */
	async whoami(): Promise<string> {
		const res = await this.req({
			url: "https://huggingface.co/api/whoami-v2",
			method: "GET",
			headers: this.authHeaders(),
		});
		if (res.status === 401) throw new HFError("Hugging Face token is invalid or expired.", 401);
		if (res.status !== 200) throw new HFError(`Could not validate token (HTTP ${res.status}).`, res.status);
		return res.json?.name ?? "unknown";
	}

	/** True if the configured repo exists and is reachable with this token. */
	async repoExists(): Promise<boolean> {
		const res = await this.req({
			url: `https://huggingface.co/api/datasets/${this.repoId}`,
			method: "GET",
			headers: this.authHeaders(),
		});
		return res.status === 200;
	}

	/**
	 * Attempts to create the bucket repo (a private HF dataset repo) if it
	 * doesn't exist yet. Returns true if it exists or was created, false with
	 * an explanation if the caller should create it manually on huggingface.co.
	 */
	async ensureRepo(): Promise<{ ok: boolean; message: string }> {
		if (await this.repoExists()) return { ok: true, message: "Bucket repo already exists." };
		const res = await this.req({
			url: "https://huggingface.co/api/repos/create",
			method: "POST",
			contentType: "application/json",
			headers: this.authHeaders(),
			body: JSON.stringify({ type: "dataset", name: this.repoId, private: true }),
		});
		if (res.status === 200 || res.status === 201) {
			return { ok: true, message: "Created a new private dataset repo on Hugging Face to use as your bucket." };
		}
		return {
			ok: false,
			message:
				`Could not auto-create the repo (HTTP ${res.status}). ` +
				`Please create a private dataset repo named "${this.repoId}" manually at huggingface.co/new-dataset, then try again.`,
		};
	}

	/** Recursively lists every file currently in the bucket. */
	async listAllFiles(): Promise<RemoteEntry[]> {
		const out: RemoteEntry[] = [];
		const walk = async (path: string) => {
			const url =
				`https://huggingface.co/api/datasets/${this.repoId}/tree/${this.revision}` +
				(path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : "");
			const res = await this.req({ url, method: "GET", headers: this.authHeaders() });
			if (res.status === 404) return; // empty repo / path
			if (res.status !== 200) {
				throw new HFError(`Failed to list bucket contents at "${path}" (HTTP ${res.status}): ${res.text?.slice(0, 200)}`, res.status);
			}
			const entries: any[] = Array.isArray(res.json) ? res.json : [];
			for (const e of entries) {
				if (e.type === "directory") {
					await walk(e.path);
				} else if (e.type === "file") {
					out.push({
						path: e.path,
						size: e.size ?? e.lfs?.size ?? 0,
						oid: e.lfs?.oid ?? e.oid ?? "",
					});
				}
			}
		};
		await walk("");
		return out;
	}

	/** Downloads a single file's raw bytes. */
	async downloadFile(path: string): Promise<ArrayBuffer> {
		const url = `https://huggingface.co/datasets/${this.repoId}/resolve/${this.revision}/${path
			.split("/")
			.map(encodeURIComponent)
			.join("/")}`;
		const res = await this.req({ url, method: "GET", headers: this.authHeaders() });
		if (res.status !== 200) {
			throw new HFError(`Failed to download "${path}" (HTTP ${res.status}).`, res.status);
		}
		return res.arrayBuffer;
	}

	/**
	 * Applies a batch of file adds/updates and deletes in a single commit via
	 * the Hub's NDJSON commit endpoint. Content is sent inline as base64, so
	 * this is intended for typical note/attachment sizes, not huge binaries.
	 */
	async commit(adds: { path: string; base64: string }[], deletes: string[], message: string): Promise<void> {
		if (adds.length === 0 && deletes.length === 0) return;
		const lines: string[] = [];
		lines.push(JSON.stringify({ key: "header", value: { summary: message } }));
		for (const a of adds) {
			lines.push(JSON.stringify({ key: "file", value: { content: a.base64, path: a.path, encoding: "base64" } }));
		}
		for (const p of deletes) {
			lines.push(JSON.stringify({ key: "deletedFile", value: { path: p } }));
		}
		const body = lines.join("\n") + "\n";
		const url = `https://huggingface.co/api/datasets/${this.repoId}/commit/${this.revision}`;
		const res = await this.req({
			url,
			method: "POST",
			contentType: "application/x-ndjson",
			headers: this.authHeaders(),
			body,
		});
		if (res.status !== 200 && res.status !== 201) {
			throw new HFError(`Commit to bucket failed (HTTP ${res.status}): ${res.text?.slice(0, 300)}`, res.status);
		}
	}
}
