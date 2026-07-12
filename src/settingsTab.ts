import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type HFBucketSyncPlugin from "./main";
import { HFClient } from "./hfClient";

export class HFSyncSettingTab extends PluginSettingTab {
	plugin: HFBucketSyncPlugin;

	constructor(app: App, plugin: HFBucketSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Hugging Face Bucket Sync" });
		containerEl.createEl("p", {
			text:
				"Connects this vault to a private Hugging Face dataset repo, used as your bucket. " +
				"Add the same bucket name and token on every device to keep them in sync.",
		});

		new Setting(containerEl)
			.setName("Bucket name")
			.setDesc('Your Hugging Face repo, as "username/repo-name". Create it once (or let this plugin create it) and reuse it on every device.')
			.addText((text) =>
				text
					.setPlaceholder("yourname/obsidian-vault-bucket")
					.setValue(this.plugin.settings.bucketName)
					.onChange(async (value) => {
						this.plugin.settings.bucketName = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Hugging Face token")
			.setDesc("A token with write access. Generate one at huggingface.co/settings/tokens.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("hf_xxxxxxxxxxxxxxxxxxxx")
					.setValue(this.plugin.settings.hfToken)
					.onChange(async (value) => {
						this.plugin.settings.hfToken = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Device label")
			.setDesc('Shown on conflict copies and commit messages, e.g. "laptop" or "phone".')
			.addText((text) =>
				text
					.setValue(this.plugin.settings.deviceLabel)
					.onChange(async (value) => {
						this.plugin.settings.deviceLabel = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Test connection / create bucket")
			.setDesc("Validates your token and, if the bucket doesn't exist yet, offers to create it as a private repo.")
			.addButton((btn) =>
				btn.setButtonText("Test & connect").onClick(async () => {
					if (!this.plugin.settings.hfToken || !this.plugin.settings.bucketName) {
						new Notice("Enter a bucket name and token first.");
						return;
					}
					btn.setDisabled(true);
					try {
						const client = new HFClient(this.plugin.settings.hfToken, this.plugin.settings.bucketName);
						const user = await client.whoami();
						const repo = await client.ensureRepo();
						new Notice(`Connected as ${user}. ${repo.message}`, 6000);
					} catch (e: any) {
						new Notice(`Connection failed: ${e?.message ?? e}`, 8000);
					} finally {
						btn.setDisabled(false);
					}
				})
			);

		containerEl.createEl("h3", { text: "Sync behavior" });
		containerEl.createEl("p", {
			text:
				"Real-time push isn't possible without a server in the middle, but these three triggers " +
				"together keep things close to instant whenever a device has Obsidian open.",
		});

		new Setting(containerEl)
			.setName("Sync on startup")
			.setDesc("Run a sync automatically when Obsidian opens this vault.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.syncOnStartup).onChange(async (v) => {
					this.plugin.settings.syncOnStartup = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Sync when a file changes")
			.setDesc("Syncs shortly after you stop editing, instead of waiting for the timer.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.syncOnFileChange).onChange(async (v) => {
					this.plugin.settings.syncOnFileChange = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Debounce after edits (seconds)")
			.setDesc("How long to wait after your last keystroke before syncing.")
			.addSlider((s) =>
				s
					.setLimits(3, 60, 1)
					.setValue(this.plugin.settings.fileChangeDebounceSeconds)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.fileChangeDebounceSeconds = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Sync when the app regains focus")
			.setDesc("Syncs immediately when you switch back to Obsidian or reopen it - the fastest way to catch changes made elsewhere.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.syncOnAppFocus).onChange(async (v) => {
					this.plugin.settings.syncOnAppFocus = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Background auto-sync")
			.setDesc("Also sync on a fixed timer, as a backstop even if nothing changed locally (catches remote-only changes while you're not typing).")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.autoSync).onChange(async (v) => {
					this.plugin.settings.autoSync = v;
					await this.plugin.saveSettings();
					this.plugin.restartAutoSync();
				})
			);

		new Setting(containerEl)
			.setName("Background sync interval (seconds)")
			.setDesc("Lower = more real-time, but more API calls and battery use. 30s is a reasonable default.")
			.addSlider((s) =>
				s
					.setLimits(15, 300, 5)
					.setValue(this.plugin.settings.syncIntervalSeconds)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.syncIntervalSeconds = v;
						await this.plugin.saveSettings();
						this.plugin.restartAutoSync();
					})
			);

		new Setting(containerEl)
			.setName("Conflict handling")
			.setDesc("What to do when the same file changed on two devices since the last sync.")
			.addDropdown((d) =>
				d
					.addOption("keep-both", "Keep both (safest)")
					.addOption("remote-wins", "Remote wins (overwrite local)")
					.addOption("local-wins", "Local wins (overwrite remote)")
					.setValue(this.plugin.settings.conflictStrategy)
					.onChange(async (v) => {
						this.plugin.settings.conflictStrategy = v as any;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Ignore patterns")
			.setDesc("Comma-separated. * matches within a folder, ** matches across folders.")
			.addTextArea((t) =>
				t.setValue(this.plugin.settings.ignorePatterns).onChange(async (v) => {
					this.plugin.settings.ignorePatterns = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Max file size to sync (MB)")
			.setDesc("Files larger than this are skipped, since large files are sent as inline base64.")
			.addText((t) =>
				t.setValue(String(this.plugin.settings.maxFileSizeMB)).onChange(async (v) => {
					const n = Number(v);
					if (!Number.isNaN(n) && n > 0) {
						this.plugin.settings.maxFileSizeMB = n;
						await this.plugin.saveSettings();
					}
				})
			);
	}
}
