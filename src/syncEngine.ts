import { App, TFile, normalizePath } from "obsidian";
import { HFClient } from "./hfClient";
import { HFSyncSettings, SyncRecord } from "./types";
import { arrayBufferToBase64, compileIgnorePatterns, hashBuffer } from "./utils";

export interface SyncLogger {
	info(msg: string): void;
	warn(msg: string): void;
}

export interface SyncResult {
	uploaded: number;
	downloaded: number;
	deletedLocal: number;
	deletedRemote: number;
	conflicts: number;
	skipped: number;
}

type Plan =
	| { action: "upload"; path: string }
	| { action: "download"; path: string }
	| { action: "delete-local"; path: string }
	| { action: "delete-remote"; path: string }
	| { action: "conflict-keep-both"; path: string }
	| { action: "conflict-remote-wins"; path: string }
	| { action: "conflict-local-wins"; path: string }
	| { action: "noop-forget"; path: string } // file exists nowhere - drop tracking record
	| { action: "noop-in-sync"; path: string } // tracked, unchanged on both sides - leave record as-is
	| { action: "confirm-in-sync"; path: string; remoteOid: string }; // untracked, but content verified identical - create record

async function ensureFolderForPath(app: App, path: string) {
	const parts = path.split("/");
	parts.pop();
	if (parts.length === 0) return;
	let cur = "";
	for (const part of parts) {
		cur = cur ? `${cur}/${part}` : part;
		const existing = app.vault.getAbstractFileByPath(cur);
		if (!existing) {
			try {
				await app.vault.createFolder(cur);
			} catch {
				/* race: created concurrently, or already exists */
			}
		}
	}
}

export class SyncEngine {
	constructor(
		private app: App,
		private client: HFClient,
		private settings: HFSyncSettings,
		private syncState: Record<string, SyncRecord>,
		private saveState: () => Promise<void>,
		private log: SyncLogger
	) {}

	private isIgnored(path: string): boolean {
		return compileIgnorePatterns(this.settings.ignorePatterns)(path);
	}

	async run(mode: "both" | "push-only" | "pull-only" = "both"): Promise<SyncResult> {
		const result: SyncResult = { uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0, skipped: 0 };

		this.log.info("Listing bucket contents…");
		const remoteFiles = await this.client.listAllFiles();
		const remoteByPath = new Map(remoteFiles.map((f) => [f.path, f]));

		const localFiles = this.app.vault.getFiles().filter((f) => !this.isIgnored(f.path));
		const localByPath = new Map(localFiles.map((f) => [f.path, f]));

		const localHashCache = new Map<string, string>();
		const maxBytes = this.settings.maxFileSizeMB * 1024 * 1024;

		const allPaths = new Set<string>([...localByPath.keys(), ...remoteByPath.keys(), ...Object.keys(this.syncState)]);

		const plans: Plan[] = [];

		for (const path of allPaths) {
			if (this.isIgnored(path)) continue;
			const known = this.syncState[path];
			const localFile = localByPath.get(path);
			const remoteFile = remoteByPath.get(path);

			// Nothing tracked, nothing present anywhere - drop it and move on.
			if (!localFile && !remoteFile) {
				plans.push({ action: "noop-forget", path });
				continue;
			}

			let localHash: string | undefined;
			if (localFile) {
				if (localFile.stat.size > maxBytes) {
					result.skipped++;
					continue;
				}
				const buf = await this.app.vault.readBinary(localFile);
				localHash = await hashBuffer(buf);
				localHashCache.set(path, localHash);
			}

			if (!known) {
				// Never synced before on this device.
				if (localFile && !remoteFile) {
					plans.push({ action: "upload", path });
				} else if (!localFile && remoteFile) {
					plans.push({ action: "download", path });
				} else if (localFile && remoteFile) {
					// Exists on both sides with no baseline - verify before assuming a conflict.
					const remoteBuf = await this.client.downloadFile(path);
					const remoteHash = await hashBuffer(remoteBuf);
					if (remoteHash === localHash) {
						plans.push({ action: "confirm-in-sync", path, remoteOid: remoteFile.oid });
					} else if (this.settings.conflictStrategy === "remote-wins") {
						plans.push({ action: "conflict-remote-wins", path });
					} else if (this.settings.conflictStrategy === "local-wins") {
						plans.push({ action: "conflict-local-wins", path });
					} else {
						plans.push({ action: "conflict-keep-both", path });
					}
				}
				continue;
			}

			// Tracked file: compare against the last known baseline.
			const localChanged = !!localFile && known.localHash !== localHash;
			const remoteChanged = !!remoteFile && known.remoteOid !== "pending" && known.remoteOid !== remoteFile.oid;
			const localDeleted = !localFile;
			const remoteDeleted = !remoteFile;

			if (localDeleted && remoteDeleted) {
				plans.push({ action: "noop-forget", path });
			} else if (localDeleted && remoteChanged) {
				plans.push({ action: "download", path }); // deleted here, edited elsewhere: keep the edit
			} else if (localDeleted) {
				plans.push({ action: "delete-remote", path });
			} else if (remoteDeleted && localChanged) {
				plans.push({ action: "upload", path }); // deleted elsewhere, edited here: keep the edit
			} else if (remoteDeleted) {
				plans.push({ action: "delete-local", path });
			} else if (localChanged && remoteChanged) {
				if (this.settings.conflictStrategy === "remote-wins") plans.push({ action: "conflict-remote-wins", path });
				else if (this.settings.conflictStrategy === "local-wins") plans.push({ action: "conflict-local-wins", path });
				else plans.push({ action: "conflict-keep-both", path });
			} else if (localChanged) {
				plans.push({ action: "upload", path });
			} else if (remoteChanged) {
				plans.push({ action: "download", path });
			} else if (known.remoteOid === "pending" && remoteFile) {
				// Never got confirmation of the real oid after a previous upload - pick it
				// up now that we've confirmed nothing else changed, without treating it as a change.
				plans.push({ action: "confirm-in-sync", path, remoteOid: remoteFile.oid });
			} else {
				plans.push({ action: "noop-in-sync", path });
			}
		}

		const adds: { path: string; base64: string }[] = [];
		const remoteDeletes: string[] = [];
		const newState: Record<string, SyncRecord> = { ...this.syncState };

		for (const plan of plans) {
			if (mode === "push-only" && ["download", "delete-local", "conflict-remote-wins"].includes(plan.action)) continue;
			if (mode === "pull-only" && ["upload", "delete-remote", "conflict-local-wins"].includes(plan.action)) continue;

			try {
				switch (plan.action) {
					case "noop-forget":
						delete newState[plan.path];
						break;

					case "noop-in-sync":
						// Already correct in newState (inherited via the initial spread) - do nothing.
						break;

					case "confirm-in-sync": {
						const hash = localHashCache.get(plan.path);
						if (hash) newState[plan.path] = { localHash: hash, remoteOid: plan.remoteOid, syncedAt: Date.now() };
						break;
					}

					case "upload": {
						const file = localByPath.get(plan.path);
						if (!file) break;
						const buf = await this.app.vault.readBinary(file);
						const base64 = arrayBufferToBase64(buf);
						adds.push({ path: plan.path, base64 });
						const hash = localHashCache.get(plan.path) ?? (await hashBuffer(buf));
						newState[plan.path] = { localHash: hash, remoteOid: "pending", syncedAt: Date.now() };
						result.uploaded++;
						break;
					}

					case "delete-remote": {
						remoteDeletes.push(plan.path);
						delete newState[plan.path];
						result.deletedRemote++;
						break;
					}

					case "download": {
						const remote = remoteByPath.get(plan.path);
						if (!remote) break;
						const buf = await this.client.downloadFile(plan.path);
						await this.writeLocal(plan.path, buf);
						newState[plan.path] = { localHash: await hashBuffer(buf), remoteOid: remote.oid, syncedAt: Date.now() };
						result.downloaded++;
						break;
					}

					case "delete-local": {
						const file = localByPath.get(plan.path);
						if (file) await this.app.vault.delete(file);
						delete newState[plan.path];
						result.deletedLocal++;
						break;
					}

					case "conflict-remote-wins": {
						const remote = remoteByPath.get(plan.path);
						if (!remote) break;
						const buf = await this.client.downloadFile(plan.path);
						await this.writeLocal(plan.path, buf);
						newState[plan.path] = { localHash: await hashBuffer(buf), remoteOid: remote.oid, syncedAt: Date.now() };
						result.conflicts++;
						break;
					}

					case "conflict-local-wins": {
						const file = localByPath.get(plan.path);
						if (!file) break;
						const buf = await this.app.vault.readBinary(file);
						const base64 = arrayBufferToBase64(buf);
						adds.push({ path: plan.path, base64 });
						newState[plan.path] = { localHash: await hashBuffer(buf), remoteOid: "pending", syncedAt: Date.now() };
						result.conflicts++;
						break;
					}

					case "conflict-keep-both": {
						const file = localByPath.get(plan.path);
						const remote = remoteByPath.get(plan.path);
						if (!file || !remote) break;
						// Save a copy of the local edit under a device-labeled name…
						const dot = plan.path.lastIndexOf(".");
						const stamp = new Date().toISOString().replace(/[:.]/g, "-");
						const label = this.settings.deviceLabel || "device";
						const conflictPath =
							dot > -1
								? `${plan.path.slice(0, dot)} (conflict ${label} ${stamp})${plan.path.slice(dot)}`
								: `${plan.path} (conflict ${label} ${stamp})`;
						const localBuf = await this.app.vault.readBinary(file);
						await this.writeLocal(conflictPath, localBuf);
						adds.push({ path: conflictPath, base64: arrayBufferToBase64(localBuf) });
						newState[conflictPath] = { localHash: await hashBuffer(localBuf), remoteOid: "pending", syncedAt: Date.now() };
						// …then bring the local copy up to date with remote.
						const remoteBuf = await this.client.downloadFile(plan.path);
						await this.writeLocal(plan.path, remoteBuf);
						newState[plan.path] = { localHash: await hashBuffer(remoteBuf), remoteOid: remote.oid, syncedAt: Date.now() };
						result.conflicts++;
						break;
					}
				}
			} catch (e: any) {
				this.log.warn(`Failed on "${plan.path}": ${e?.message ?? e}`);
				result.skipped++;
			}
		}

		if (adds.length || remoteDeletes.length) {
			this.log.info(`Committing ${adds.length} change(s) and ${remoteDeletes.length} deletion(s) to the bucket…`);
			await this.client.commit(adds, remoteDeletes, `Obsidian sync from ${this.settings.deviceLabel || "device"}`);
			// Re-list changed files to capture their new remote oids for the baseline.
			// If this doesn't catch every path (e.g. brief indexing lag), the "pending"
			// marker is treated as "not remotely changed" next run, so it self-heals on
			// the following sync instead of producing a false conflict.
			if (adds.length) {
				const refreshed = await this.client.listAllFiles();
				const refreshedByPath = new Map(refreshed.map((f) => [f.path, f]));
				for (const a of adds) {
					const r = refreshedByPath.get(a.path);
					if (r && newState[a.path]) newState[a.path].remoteOid = r.oid;
				}
			}
		}

		Object.keys(this.syncState).forEach((k) => delete this.syncState[k]);
		Object.assign(this.syncState, newState);
		await this.saveState();

		return result;
	}

	private async writeLocal(path: string, buf: ArrayBuffer) {
		const normalized = normalizePath(path);
		await ensureFolderForPath(this.app, normalized);
		const existing = this.app.vault.getAbstractFileByPath(normalized);
		if (existing instanceof TFile) {
			await this.app.vault.modifyBinary(existing, buf);
		} else {
			await this.app.vault.createBinary(normalized, buf);
		}
	}
}
