export type ConflictStrategy = "remote-wins" | "local-wins" | "keep-both";

export interface HFSyncSettings {
	hfToken: string;
	bucketName: string; // "owner/repo" - the HF dataset repo used as the bucket
	deviceLabel: string;
	autoSync: boolean;
	syncIntervalSeconds: number;
	syncOnStartup: boolean;
	syncOnFileChange: boolean;
	fileChangeDebounceSeconds: number;
	syncOnAppFocus: boolean;
	ignorePatterns: string;
	conflictStrategy: ConflictStrategy;
	maxFileSizeMB: number;
}

export const DEFAULT_SETTINGS: HFSyncSettings = {
	hfToken: "",
	bucketName: "",
	deviceLabel: "",
	autoSync: true,
	syncIntervalSeconds: 30,
	syncOnStartup: true,
	syncOnFileChange: true,
	fileChangeDebounceSeconds: 8,
	syncOnAppFocus: true,
	ignorePatterns: ".obsidian/**, .trash/**, .git/**, **/.DS_Store",
	conflictStrategy: "keep-both",
	maxFileSizeMB: 25,
};

/** Baseline record of what was last known to be in sync, per file path. */
export interface SyncRecord {
	localHash: string;
	remoteOid: string;
	syncedAt: number;
}

export interface HFSyncData {
	settings: HFSyncSettings;
	syncState: Record<string, SyncRecord>;
}
