/** SHA-256 hash of a buffer, as a hex string. Used only to detect local changes. */
export async function hashBuffer(buf: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", buf);
	const bytes = new Uint8Array(digest);
	let hex = "";
	for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
	return hex;
}

/** Converts an ArrayBuffer to base64 without blowing the call stack on large files. */
export function arrayBufferToBase64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	const chunkSize = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

/** Converts a comma-separated list of simple glob patterns (supporting * and **) into matchers. */
export function compileIgnorePatterns(raw: string): (path: string) => boolean {
	const patterns = raw
		.split(",")
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
	const regexes = patterns.map((p) => {
		let re = p
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replace(/\*\*/g, "\u0000")
			.replace(/\*/g, "[^/]*")
			.replace(/\u0000/g, ".*");
		return new RegExp("^" + re + "$");
	});
	return (path: string) => regexes.some((re) => re.test(path));
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	const units = ["KB", "MB", "GB"];
	let val = n / 1024;
	let i = 0;
	while (val >= 1024 && i < units.length - 1) {
		val /= 1024;
		i++;
	}
	return `${val.toFixed(1)} ${units[i]}`;
}
