// "1D 8C D6 05 C0 DA" - a run of bytes, two digits each.
export function toHexBytes(bytes) {
	return Array.from(bytes, (b) => toHex(b)).join(' ');
}

// H'0F, H'014DF: upper case, zero padded to `width` digits.
export function toHex(value, width = 2) {
	return value.toString(16).toUpperCase().padStart(width, '0');
}

// Short runs in seconds, the rest in whole minutes.
export function formatDuration(seconds) {
	return seconds < 90 ? `${seconds} s` : `${Math.round(seconds / 60)} min.`;
}
