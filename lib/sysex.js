// Every complete SysEx message in the capture, in order, each one H'F0 to H'F7.
export function loadCapture(bytes) {
	bytes = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
	if (String.fromCharCode(...bytes.slice(0, 4)) === 'MThd') {
		return extractSysexFromSmf(bytes);
	}
	if (looksLikeHexText(bytes)) {
		return splitSysex(decodeHexText(bytes));
	}
	return splitSysex(bytes);
}

// Pull the SysEx events out of a standard MIDI file, in order.
function extractSysexFromSmf(bytes) {
	const events = [];
	let i = 0;
	while (i < bytes.length) {
		if (bytes[i] !== 0xf0) {
			i++;
			continue;
		}
		let p = i + 1;
		let n = 0;
		while (p < bytes.length && bytes[p] & 0x80) {
			n = (n << 7) | (bytes[p++] & 0x7f);
		}
		n = (n << 7) | bytes[p++];
		const end = p + n;
		// the event says where it ends, and a real one ends on H'F7
		if (end > bytes.length || bytes[end - 1] !== 0xf7) {
			i++;
			continue;
		}
		events.push(Uint8Array.from([0xf0, ...bytes.subarray(p, end)]));
		i = end;
	}

	return events;
}

// Is this file hex text rather than binary?
function looksLikeHexText(bytes) {
	if (!bytes.length) {
		return false;
	}
	for (const byte of bytes) {
		if (byte >= 0x80) {
			return false;
		}
	}

	// and it has to actually spell something
	for (let i = 1; i < bytes.length; i++) {
		if (hexDigit(bytes[i - 1]) >= 0 && hexDigit(bytes[i]) >= 0) {
			return true;
		}
	}

	return false;
}

// Decode "F0 41 10 42 ..." into the bytes it spells.
function decodeHexText(text) {
	const raw = (typeof text === 'string')
		? Uint8Array.from(text, (char) => char.charCodeAt(0))
		: ((text instanceof Uint8Array) ? text : new Uint8Array(text));
	const bytes = [];
	let highNibble = -1;
	for (const byte of raw) {
		const digit = hexDigit(byte);
		if (digit < 0) {
			highNibble = -1;            // a lone digit before this is dropped
		} else if (highNibble < 0) {
			highNibble = digit;
		} else {
			bytes.push((highNibble << 4) | digit);
			highNibble = -1;
		}
	}

	return Uint8Array.from(bytes);
}

function hexDigit(byte) {
	if (byte >= 0x30 && byte <= 0x39) {
		return byte - 0x30;
	}
	if (byte >= 0x61 && byte <= 0x66) {
		return byte - 0x61 + 10;
	}
	if (byte >= 0x41 && byte <= 0x46) {
		return byte - 0x41 + 10;
	}

	return -1;
}

// Split a raw .syx stream into complete messages.
function splitSysex(bytes) {
	const out = [];
	let message = null;
	for (const byte of bytes) {
		if (byte === 0xf0) {
			message = [byte];
		} else if (message) {
			message.push(byte);
			if (byte === 0xf7) {
				out.push(Uint8Array.from(message));
				message = null;
			}
		}
	}

	return out;
}

// How long `bytes` bytes take on the wire.
export function calcTransferMs(bytes) {
	return Math.ceil(bytes * 10 / 31.25);
}
