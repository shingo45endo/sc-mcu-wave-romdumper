// How to ask an SC-88 family synth for its wave ROM, one pass at a time.
//
// One call of the dumper reads a fixed number of bytes into the buffer, and the host reads the buffer back. That is
// a pass. A pass must not cross a 1 MiB bank, because the dumper writes the bank register once per call.
//
// A bank is not a whole number of passes, so the last pass of each bank is moved back to end on the boundary and
// reads part of the one before it again. Every pass is placed by its own offset, so the overlap costs a little time
// and nothing else.
//
// Nothing here depends on a reply, so the host can write the whole sequence out in advance.

import {buildFileHeader, buildPassHeader, HEADER_SIZE, toAddress} from './bulk_dump.js';
import {buildRequestMessage, buildWriteMessage, triggerMessage} from './gs_message.js';

export const BANK_SIZE = 0x100000;
export const CHIP_SELECT_SIZE = 0x200000;	// how much address space one chip select takes, whatever is fitted

export function planPasses(size, passSize, {bankSize = BANK_SIZE} = {}) {
	console.assert(passSize > 0 && passSize <= bankSize, 'a pass has to fit inside a bank');
	const passes = [];
	for (let base = 0; base < size; base += bankSize) {
		const end = Math.min(base + bankSize, size);
		for (let at = base; at < end; at += passSize) {
			passes.push({at: Math.min(at, end - passSize), size: passSize});
		}
	}

	return passes;
}

// The four values the dumper reads out of its request block.
//   +0  the bank register: chip select and address bit 20
//   +2  the page register: address bits 19-10
//   +4  the byte offset in the 1 KB window, even
//   +6  how many seven-byte groups to fill
export function toRequestBytes(chipNo, at, groups) {
	const addr = (chipNo * CHIP_SELECT_SIZE) + at;
	const words = [
		(((addr >> 21) & 0x03) << 4) | ((addr >> 20) & 0x01),
		(addr >> 10) & 0x3ff,
		addr & 0x3fe,
		groups,
	];

	return Uint8Array.from(words.flatMap((word) => [(word >> 8) & 0xff, word & 0xff]));
}

// These have to match src/88/dumper_88.inc. Drum Map Name is the drum map's last field, which is where the SC-55
// dumper takes its arguments too.
const ARG_OFFSET = 0x380;
const ARG_LEN = 12;
const BLOCK_SIZE = 0x40;
const MAP_NO = 1;
const GROUP_BYTES = 7;

// Asking for more than an area holds returns the rest of it, whatever an address step means on this revision.
const WHOLE_AREA = 0x2000;

// What each message has to be followed by when nothing waits for a reply. The last request of a pass waits for the
// synth's whole answer; the others are queued behind it, which is what makes a pass take one wait rather than four.
export const GAP_REQUEST_MS = 20;
export const GAP_TRIGGER_MS = 150;	// long enough for the dumper to finish
export const GAP_READ_MS = 0;
export const GAP_ANSWER_MS = 4500;	// a prepared file cannot see the answer, so it leaves room

// What the answer to a pass really costs, for a host that waits for it instead of leaving room.
// Measured on an SC-88VL: 4186 ms a pass, of which 210 ms is the asking.
export const ANSWER_MS = 4000;

// The areas the buffer is made of, with their addresses as bytes.
export function toRegions(readRegions) {
	return readRegions.map((region) => ({addr: toAddress(region.addr), size: region.size}));
}

// How much of the wave ROM one pass carries: the buffer, less the header, seven bytes to the group.
export function getPassBytes(regions) {
	const bufferSize = regions.reduce((total, region) => (total + region.size), 0);
	const passBytes = ((bufferSize - HEADER_SIZE) / 8) * GROUP_BYTES;
	console.assert(Number.isInteger(passBytes), 'the areas must hold the header and a whole number of groups');

	return passBytes;
}

// Ask for every area the buffer is made of, and wait for the lot.
function buildReadBack(regions) {
	return regions.map((region, i) => ({
		bytes: buildRequestMessage(region.addr, WHOLE_AREA),
		gapMs: (i === regions.length - 1) ? GAP_ANSWER_MS : GAP_READ_MS,
	}));
}

// One pass: put the header and the request in place, call the dumper, then read the buffer back.
export function buildPass(chipNo, pass, regions) {
	const groups = pass.size / GROUP_BYTES;
	console.assert(Number.isInteger(groups), 'a pass is a whole number of groups');
	console.assert(toRequestBytes(chipNo, pass.at, groups).length <= ARG_LEN, 'the request fits in Drum Map Name');
	const request = [0x49, (MAP_NO << 4) | (ARG_OFFSET / BLOCK_SIZE), 0x00];

	return [
		{bytes: buildWriteMessage(regions[0].addr, buildPassHeader({at: pass.at, size: pass.size}), {isNibble: false}),
			gapMs: GAP_REQUEST_MS},
		{bytes: buildWriteMessage(request, toRequestBytes(chipNo, pass.at, groups)), gapMs: GAP_REQUEST_MS},
		{bytes: triggerMessage(), gapMs: GAP_TRIGGER_MS},
		...buildReadBack(regions),
	];
}

// The file header is written and read straight back. The dumper is never called, so it takes one wait.
export function buildFileHeaderPass(regions, {size, passCount, name}) {
	return [
		{bytes: buildWriteMessage(regions[0].addr, buildFileHeader({size, passCount, name}), {isNibble: false}),
			gapMs: GAP_REQUEST_MS},
		...buildReadBack(regions),
	];
}
