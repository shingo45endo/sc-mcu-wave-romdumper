import {calcTransferMs} from '../lib/sysex.js';

const DEFAULT_GAP_MS = 250;

// A format 0 file with one SysEx event per message. The division is 1000 ticks per quarter note and the tempo one
// second per quarter, so a tick is exactly a millisecond, and the delta before each message is the previous message's
// own time on the wire plus `gapMs` - which makes `gapMs` a real pause, whatever the player's idea of tempo.
export function writeSmf(messages, {gapMs = DEFAULT_GAP_MS, name = 'sc-mcu-wave-romdumper'} = {}) {
	console.assert(gapMs >= 0, 'the gap between messages cannot be negative');
	const eventBytes = [];
	const push = (...b) => eventBytes.push(...b);

	const nameBytes = Array.from(name, (c) => c.charCodeAt(0));
	if (nameBytes.some((e) => (e < 0x20 || e > 0x7e))) {
		throw new Error(`the track name ${JSON.stringify(name)} is not printable ASCII`);
	}

	push(...toVlq(0), 0xff, 0x03, ...toVlq(nameBytes.length), ...nameBytes);
	push(...toVlq(0), 0xff, 0x51, 0x03, 0x0f, 0x42, 0x40);       // 1 000 000 us
	let prev = 0;
	for (const message of messages) {
		push(...toVlq((prev) ? calcTransferMs(prev) + gapMs : 0));
		prev = message.length;
		push(0xf0, ...toVlq(message.length - 1), ...message.slice(1));
	}
	push(...toVlq(0), 0xff, 0x2f, 0x00);

	const toBe32 = (value) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
	return Uint8Array.from([
		0x4d, 0x54, 0x68, 0x64,		// "MThd"
		...toBe32(6),
		0x00, 0x00,
		0x00, 0x01,
		0x03, 0xe8,
		0x4d, 0x54, 0x72, 0x6b,		// "MTrk"
		...toBe32(eventBytes.length),
		...eventBytes,
	]);
}

function toVlq(value) {
	const bytes = [value & 0x7f];
	value >>= 7;
	while (value) {
		bytes.unshift((value & 0x7f) | 0x80);
		value >>= 7;
	}

	return bytes;
}

export function concatSysex(messages) {
	let size = 0;
	for (const message of messages) {
		size += message.length;
	}

	const bytes = new Uint8Array(size);
	let i = 0;
	for (const message of messages) {
		bytes.set(message, i);
		i += message.length;
	}

	return bytes;
}
