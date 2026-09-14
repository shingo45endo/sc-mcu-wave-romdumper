// --------------------------------
// asking
// --------------------------------
const DEFAULT_DEVICE_ID = 0x10;

const SYSTEM_INFO_SIZE = 0x20;
const PING_ADDR = [0x40, 0x30, 0x00];
const PING_SIZE = [0x00, 0x00, SYSTEM_INFO_SIZE];

// Every device id a GS unit can be set to: 17..32, sent as H'10..H'1F.
export const DEVICE_IDS = Array.from({length: 16}, (_, i) => 0x10 + i);

// F0 41 10 42 11 40 30 00 00 00 20 70 F7
export function pingMessage(device = DEFAULT_DEVICE_ID) {
	return buildRolandMessage(0x11, [...PING_ADDR, ...PING_SIZE], device);
}

// Device id of a reply to pingMessage, or null if this is not one.
export function parsePingReplyDevice(message) {
	if (message.length < 12) {
		return null;
	}
	if (message[0] !== 0xf0 || message[1] !== 0x41 || message[3] !== 0x42 || message[4] !== 0x12) {
		return null;
	}
	for (let i = 0; i < PING_ADDR.length; i++) {
		if (message[5 + i] !== PING_ADDR[i]) {
			return null;
		}
	}

	return message[2];
}

// The block itself: everything between the address and the checksum.
export function parsePingReplyData(message) {
	return Uint8Array.from(message.slice(8, -2));
}

// Rewrite the device id of a prepared Roland message. No checksum covers that byte, so the prepared .syx files can be
// retargeted without rebuilding them. Anything that is not a Roland message is returned untouched.
export function rewriteDeviceId(message, device) {
	const out = Uint8Array.from(message);
	if (out.length > 5 && out[0] === 0xf0 && out[1] === 0x41 && out[3] === 0x42) {
		out[2] = device & 0x7f;
	}

	return out;
}

// F0 41 dev 42 <cmd> <body> <sum> F7
function buildRolandMessage(command, body, device) {
	return Uint8Array.from([0xf0, 0x41, device, 0x42, command, ...body, calcChecksum(body), 0xf7]);
}

function calcChecksum(bytes) {
	let sum = 0;
	for (const byte of bytes) {
		sum = (sum + byte) & 0x7f;
	}
	return (128 - sum) & 0x7f;
}

// --------------------------------
// reading the answer
// --------------------------------
export function evaluateSystemInfo(bytes, {models, notOffered = {}, selected} = {}) {
	if (!bytes || !bytes.length) {
		return {kind: 'none'};
	}
	const text = toSystemInfoText(bytes);
	// The block is 32 bytes. Anything else is not one, whatever it reads as.
	if (bytes.length !== SYSTEM_INFO_SIZE) {
		return {kind: 'unknown', text};
	}
	const keys = findMatchingModels(models, (entry) => bytesMatch(bytes, entry));
	if (!keys.length) {
		return {kind: 'unknown', text};
	}

	return buildAnswer(models, keys, {notOffered, selected, text});
}

export function toSystemInfoText(bytes) {
	let text = '';
	for (const byte of bytes) {
		text += (byte >= 0x20 && byte < 0x7f) ? String.fromCharCode(byte) : ' ';
	}
	return text.trim();
}

// Every model an entry test picks out, in catalogue order.
function findMatchingModels(models, test) {
	return Object.keys(models).filter((key) => (models[key].systemInfo ?? []).some((entry) => test(entry)));
}

function bytesMatch(bytes, entry) {
	const want = decodeEntryBytes(entry);
	if (bytes.length !== want.length) {
		return false;
	}
	for (let i = 0; i < want.length; i++) {
		if (bytes[i] !== want.charCodeAt(i)) {
			return false;
		}
	}

	return true;
}

function decodeEntryBytes(entry) {
	if (entry.length === 64 && (/^[0-9a-fA-F]{64}$/u).test(entry)) {
		const bytes = [];
		for (let i = 0; i < 64; i += 2) {
			bytes.push(parseInt(entry.slice(i, i + 2), 16));
		}
		return String.fromCharCode(...bytes);
	}
	return entry;
}

function buildAnswer(models, keys, {notOffered, selected, text}) {
	// Every key agrees about the layout - see tools/mksyx.js - so the first one speaks for all of them.
	const {config} = models[keys[0]];
	const labels = keys.map((key) => models[key].label);

	// Every model this block names is one the caller does not offer.
	const shownKeys = keys.filter((key) => !notOffered[key]);
	if (!shownKeys.length) {
		return {kind: 'elsewhere', keys, labels, config, reason: notOffered[keys[0]], text};
	}

	const isAgreement = (selected && models[selected] && (models[selected].config === config));
	return {kind: (isAgreement) ? 'match' : 'mismatch', keys, labels, config, text};
}
