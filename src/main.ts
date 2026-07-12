import { Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, HFSyncData, HFSyncSettings, SyncRecord } from "./types";
import { HFClient } from "./hfClient";
import { SyncEngine, SyncResult } from "./syncEngine";
import { HFSyncSettingTab } from "./settingsTab";

export default class HFBucketSyncPlugin extends Plugin {
	settings!: HFSyncSettings;
	syncState: Record<string, SyncRecord> = {};
	statusBarEl!: HTMLElement;
	private intervalId: number | null = null;
	private debounceTimer: number | null = null;
	private syncing = false;
	private pendingSyncQueued = false;

	async onload() {
		await this.loadPluginData();

		if (!this.settings.deviceLabel) {
			this.settings.deviceLabel = this.guessDeviceLabel();
			await this.saveSettings();
		}

		this.addSettingTab(new HFSyncSettingTab(this.app, this));

		this.statusBarEl = this.addStatusBarItem();
		this.setStatus("HF Sync: idle");

		this.addRibbonIcon("refresh-cw", "Sync with HF bucket", () => this.triggerSync("both"));

		this.addCommand({
			id: "hf-bucket-sync-now",
			name: "Sync now (both directions)",
			callback: () => this.triggerSync("both"),
		});
		this.addCommand({
			id: "hf-bucket-push",
			name: "Push local changes to bucket",
			callback: () => this.triggerSync("push-only"),
		});
		this.addCommand({
			id: "hf-bucket-pull",
			name: "Pull changes from bucket",
			callback: () => this.triggerSync("pull-only"),
		});

		this.restartAutoSync();
		this.registerChangeListeners();
		this.registerFocusListeners();

		if (this.settings.syncOnStartup) {
			// Let the workspace settle before touching the vault.
			this.app.workspace.onLayoutReady(() => this.triggerSync("both", true));
		}
	}

	onunload() {
		if (this.intervalId) window.clearInterval(this.intervalId);
		if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
	}

	guessDeviceLabel(): string {
		// @ts-ignore - Platform is exposed at runtime by Obsidian
		const platform = (window as any).require ? "desktop" : "mobile";
		return `${platform}-${Math.random().toString(36).slice(2, 6)}`;
	}

	async loadPluginData() {
		const data = ((await this.loadData()) as HFSyncData) || undefined;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);
		this.syncState = data?.syncState ?? {};
	}

	async saveSettings() {
		await this.persist();
	}

	async saveSyncState() {
		await this.persist();
	}

	private async persist() {
		const data: HFSyncData = { settings: this.settings, syncState: this.syncState };
		await this.saveData(data);
	}

	restartAutoSync() {
		if (this.intervalId) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
		if (this.settings.autoSync) {
			const ms = Math.max(15, this.settings.syncIntervalSeconds) * 1000;
			this.intervalId = window.setInterval(() => this.triggerSync("both", true), ms);
			this.registerInterval(this.intervalId);
		}
	}

	/** Syncs shortly after any vault file change, debounced so rapid edits collapse into one sync. */
	private registerChangeListeners() {
		const queue = () => {
			if (!this.settings.syncOnFileChange) return;
			if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
			const ms = Math.max(3, this.settings.fileChangeDebounceSeconds) * 1000;
			this.debounceTimer = window.setTimeout(() => this.triggerSync("both", true), ms);
			this.registerInterval(this.debounceTimer);
		};
		this.registerEvent(this.app.vault.on("modify", queue));
		this.registerEvent(this.app.vault.on("create", queue));
		this.registerEvent(this.app.vault.on("delete", queue));
		this.registerEvent(this.app.vault.on("rename", queue));
	}

	/** Syncs as soon as the app regains focus/visibility - covers "just reopened the app". */
	private registerFocusListeners() {
		const onVisible = () => {
			if (!this.settings.syncOnAppFocus) return;
			if (document.visibilityState === "visible") this.triggerSync("both", true);
		};
		this.registerDomEvent(document, "visibilitychange", onVisible);
		this.registerDomEvent(window, "focus", onVisible);
	}

	setStatus(text: string) {
		this.statusBarEl.setText(text);
	}

	async triggerSync(mode: "both" | "push-only" | "pull-only", silent = false) {
		if (this.syncing) {
			this.pendingSyncQueued = true;
			if (!silent) new Notice("A sync is already in progress - will run again right after.");
			return;
		}
		if (!this.settings.hfToken || !this.settings.bucketName) {
			if (!silent) new Notice("Set your bucket name and HF token in plugin settings first.");
			return;
		}

		this.syncing = true;
		this.setStatus("HF Sync: syncing…");
		const client = new HFClient(this.settings.hfToken, this.settings.bucketName);
		const engine = new SyncEngine(
			this.app,
			client,
			this.settings,
			this.syncState,
			() => this.saveSyncState(),
			{
				info: (m) => console.log(`[HF Bucket Sync] ${m}`),
				warn: (m) => console.warn(`[HF Bucket Sync] ${m}`),
			}
		);

		try {
			const result: SyncResult = await engine.run(mode);
			const parts: string[] = [];
			if (result.uploaded) parts.push(`↑${result.uploaded}`);
			if (result.downloaded) parts.push(`↓${result.downloaded}`);
			if (result.deletedLocal) parts.push(`-local ${result.deletedLocal}`);
			if (result.deletedRemote) parts.push(`-remote ${result.deletedRemote}`);
			if (result.conflicts) parts.push(`conflicts ${result.conflicts}`);
			if (result.skipped) parts.push(`skipped ${result.skipped}`);
			const summary = parts.length ? parts.join(" · ") : "up to date";
			const now = new Date().toLocaleTimeString();
			this.setStatus(`HF Sync: ${summary} (${now})`);
			if (!silent || result.uploaded || result.downloaded || result.deletedLocal || result.deletedRemote || result.conflicts) {
				new Notice(`HF Bucket Sync: ${summary}`, 5000);
			}
		} catch (e: any) {
			console.error("[HF Bucket Sync] failed", e);
			this.setStatus("HF Sync: error");
			new Notice(`HF Bucket Sync failed: ${e?.message ?? e}`, 8000);
		} finally {
			this.syncing = false;
			if (this.pendingSyncQueued) {
				this.pendingSyncQueued = false;
				window.setTimeout(() => this.triggerSync("both", true), 500);
			}
		}
	}
}

