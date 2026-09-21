import {MAGIC_WORD} from './hook.js';
import {calcCrc32, findPatternAll, matchPatternAt, toWord} from './rom_search.js';

// Bytes the trampoline needs in free ROM space.
const TRAMPOLINE_SIZE = 22;

// The interrupt vectors are at the start of bank 0. Unused entries read as H'FF, so they look free, but code must
// not go there.
const VECTOR_TABLE_SIZE = 0x200;

// The DT1 handler for 40 1x 17 folds two SysEx nibbles into one byte. The high nibble is shifted up four times in a row:
//     AC 0D        ADD:G.W  #-2,R4
//     2B xx        BMI      done
//     C1 80        MOV:G.B  @R1+,R0
//     A0 1A        SHLL.B   R0     x4
//     C1 40        OR:G.B   @R1+,R0
const WRITE_CORE = [
	0xac, 0x0d,
	0x2b, null,
	0xc1, 0x80,
	0xa0, 0x1a,
	0xa0, 0x1a,
	0xa0, 0x1a,
	0xa0, 0x1a,
	0xc1, 0x40,
];

// The matching RQ1 handler splits one byte back into two nibbles.
const READ_CORE = [
	0xac, 0x0d,
	0x2b, null,
	0xd2, 0x80,
	0xa0, 0x1b,
	0xa0, 0x1b,
	0xa0, 0x1b,
	0xa0, 0x1b,
	0xc1, 0x90,
];

// One parameter table entry: write handler, read handler, parameter number, lowest value, highest value.
const ENTRY_SIZE = 8;
const ENTRY_LOWEST = 0x08;
const ENTRY_HIGHEST = 0xf8;

// One bulk dump region: a zero, the three address bytes, the RAM address, the size.
const BULK_ENTRY_SIZE = 8;
const BULK_FAMILIES = [0x08, 0x28, 0x29, 0x48, 0x49, 0x58, 0x59];
const BULK_MIN_ENTRIES = 8;

// Drum map 2 of the first port. This is the area the dumper is loaded into, so it is also where the hook jumps.
const LOAD_REGION = [0x49, 0x10, 0x00];

// The bulk dump table gives 16 bit RAM addresses, so the page they sit in has to come from somewhere else.
// The firmware says it every time it touches RAM:
//     04 pp 8D     LDC.B  #page,DP
const PAGE_LOAD = [0x04, null, 0x8d];
const PAGE_MARGIN = 2;

// --------------------------------
// reading a ROM
// --------------------------------

// Normalize 16-bit-wide ROM with ambiguous byte orders.
function normalizeRom(rom) {
	if (findPatternAll(rom, WRITE_CORE, 1).length > 0) {
		return {rom, isSwapped: false};
	}
	const swappedRom = swapBytes(rom);

	return (findPatternAll(swappedRom, WRITE_CORE, 1).length > 0) ? {rom: swappedRom, isSwapped: true} : {rom, isSwapped: false};
}

// Swap the two bytes of every word. Its own inverse.
export function swapBytes(rom) {
	const out = rom.slice();
	for (let i = 0; i + 1 < out.length; i += 2) {
		const first = out[i];
		out[i] = out[i + 1];
		out[i + 1] = first;
	}

	return out;
}

// `crc32` and every address are of the image the right way round, so two files that are byte swaps of each other report the same numbers.
export function analyzeRom(rawRom) {
	if (!(rawRom instanceof Uint8Array)) {
		rawRom = new Uint8Array(rawRom);
	}
	const {rom, isSwapped} = normalizeRom(rawRom);
	const hook = findHook(rom);
	const bulk = findBulkTable(rom);
	const ramPage = findRamPage(rom);
	const entries = (hook.isOk) ? findEntries(rom, hook) : {isOk: false, reasonCode: 'no-hook'};
	const stub = (hook.isOk && entries.isOk)
		? findStub(rom, hook, entries)
		: {isOk: false, isPatched: false, reasonCode: (hook.isOk) ? 'no-table-entry' : 'no-hook'};

	return {
		size: rom.length,
		crc32: calcCrc32(rom),
		isSwapped,
		models: findSystemInfo(rom),
		hook,
		entries,
		bulk,
		ramPage,
		stub,
		isReady: hook.isOk && entries.isOk && bulk.isOk && ramPage.isOk && stub.isOk,
		loadAddr: (bulk.isOk && ramPage.isOk) ? ((ramPage.page << 16) | bulk.load.addr) : null,
	};
}

// The page the firmware's own data lives in, taken from the value it loads into DP most often.
function findRamPage(rom) {
	const counts = new Map();
	for (const at of findPatternAll(rom, PAGE_LOAD)) {
		const page = rom[at + 1];
		counts.set(page, (counts.get(page) ?? 0) + 1);
	}
	const ranked = [...counts.entries()].sort((a, b) => (b[1] - a[1]));
	if (ranked.length === 0) {
		return {isOk: false, reasonCode: 'ram-page-not-found'};
	}
	const [page, count] = ranked[0];
	const runnerUp = ranked[1]?.[1] ?? 0;
	if (count < runnerUp * PAGE_MARGIN) {
		return {
			isOk: false, reasonCode: 'ram-page-ambiguous',
			page, count, runnerUpPage: ranked[1][0], runnerUpCount: runnerUp,
		};
	}

	return {isOk: true, page, count, runnerUpPage: ranked[1]?.[0] ?? null, runnerUpCount: runnerUp};
}

// The write handler and the read handler, both of which must be unique.
function findHook(rom) {
	const writes = findPatternAll(rom, WRITE_CORE, 4);
	const reads = findPatternAll(rom, READ_CORE, 4);
	if (writes.length === 0 || reads.length === 0) {
		return {isOk: false, reasonCode: 'handler-not-found'};
	}
	if (writes.length > 1 || reads.length > 1) {
		return {isOk: false, reasonCode: 'handler-ambiguous', matchCount: Math.max(writes.length, reads.length)};
	}

	return {isOk: true, write: writes[0], read: reads[0]};
}

// Entries are found by the read handler, which the patch never touches.
function findEntries(rom, hook) {
	const read = hook.read & 0xffff;
	const found = [];
	for (let at = 0; at + ENTRY_SIZE <= rom.length; at++) {
		if (toWord(rom, at + 2) !== read || rom[at + 6] !== ENTRY_LOWEST || rom[at + 7] !== ENTRY_HIGHEST) {
			continue;
		}
		found.push({offset: at, write: toWord(rom, at), paramNo: toWord(rom, at + 4)});
	}
	if (found.length === 0) {
		return {isOk: false, reasonCode: 'table-entry-not-found'};
	}

	return {isOk: true, list: found};
}

// The table of bulk dump regions. Each region says where it is in RAM and how long it is, so the address to load the
// dumper at is read out of the ROM rather than guessed.
function findBulkTable(rom) {
	const found = [];
	for (let at = 0; at + BULK_ENTRY_SIZE <= rom.length; at++) {
		if (rom[at] !== 0x00 || rom[at + 1] !== BULK_FAMILIES[0] || rom[at + 2] !== 0x00 || rom[at + 3] !== 0x00) {
			continue;
		}
		const list = readBulkEntries(rom, at);
		if (list.length >= BULK_MIN_ENTRIES) {
			found.push({offset: at, list});
		}
	}
	if (found.length === 0) {
		return {isOk: false, reasonCode: 'bulk-table-not-found'};
	}
	if (found.length > 1) {
		return {isOk: false, reasonCode: 'bulk-table-ambiguous', candidateCount: found.length};
	}

	const {offset, list} = found[0];
	const load = list.find((region) => LOAD_REGION.every((byte, i) => (region.addr3[i] === byte)));
	if (!load) {
		return {isOk: false, reasonCode: 'load-region-not-found'};
	}

	return {isOk: true, offset, list, load};
}

function readBulkEntries(rom, at) {
	const list = [];
	for (let p = at; p + BULK_ENTRY_SIZE <= rom.length; p += BULK_ENTRY_SIZE) {
		if (rom[p] !== 0x00 || !BULK_FAMILIES.includes(rom[p + 1])) {
			break;
		}
		list.push({
			offset: p,
			addr3: [rom[p + 1], rom[p + 2], rom[p + 3]],
			addr: toWord(rom, p + 4),
			size: toWord(rom, p + 6),
		});
	}

	return list;
}

// Where the stub is, or would go, and how that was decided.
//   'existing'   an entry already points somewhere other than the handler, so this tool has patched this image.
//   'searched'   not patched: the largest gap in the bank.
function findStub(rom, hook, entries) {
	const bank = hook.write & ~0xffff;
	const patched = entries.list.find((entry) => (entry.write !== (hook.write & 0xffff)));
	if (patched) {
		return {isOk: true, at: bank + patched.write, how: 'existing', isPatched: true};
	}

	const free = findFreeSpace(rom, hook.write);
	if (!free.isOk) {
		return {
			isOk: false, isPatched: false,
			reasonCode: free.reasonCode, neededSize: free.neededSize, longestSize: free.longestSize,
		};
	}

	return {
		isOk: true, at: free.offset, how: 'searched',
		isPatched: false, run: free.run, runSize: free.runSize,
	};
}

// Somewhere in the same 64 KiB bank to put the trampoline. The table entry holds a 16 bit address, so the bank is not a
// preference but a requirement.
//
// Only a gap counts as free: a run of H'FF with real bytes on both sides. A run that reaches the end of the bank is
// rejected, because the board may not decode that address at all. The firmware uses only addresses the board decodes,
// so a gap between two things the firmware uses is the one kind that is known to be reachable.
function findFreeSpace(rom, hookOffset, neededSize = TRAMPOLINE_SIZE) {
	const bank = hookOffset & ~0xffff;
	const end = Math.min(bank + 0x10000, rom.length);
	const codeStart = bank + ((bank === 0) ? VECTOR_TABLE_SIZE : 0);

	let best = null;
	let longestSize = 0;
	let at = codeStart;
	while (at < end) {
		if (rom[at] !== 0xff) {
			at++;
			continue;
		}
		let to = at;
		while (to < end && rom[to] === 0xff) {
			to++;
		}
		const size = to - at;
		longestSize = Math.max(longestSize, size);
		const isGap = (at > codeStart && to < end);
		if (isGap && size >= neededSize && (!best || size > best.size)) {
			best = {offset: at, size};
		}
		at = to;
	}
	if (!best) {
		return {isOk: false, reasonCode: 'bank-has-no-free-run', neededSize, longestSize};
	}

	// start on an even address inside the gap
	const even = ((best.offset + 1) & ~1);
	const offset = ((even + neededSize <= best.offset + best.size) ? even : best.offset);

	return {isOk: true, offset, run: best.offset, runSize: best.size};
}

// The blocks a connection check reads back. One image holds several of them, one per model built from the same firmware.
const SYSTEM_INFO_HEAD = 'GS-64 VER=';
const SYSTEM_INFO_SIZE = 0x20;

function findSystemInfo(rom) {
	const head = Array.from(SYSTEM_INFO_HEAD, (character) => character.charCodeAt(0));
	const found = [];
	for (let at = 0; at + SYSTEM_INFO_SIZE <= rom.length; at++) {
		if (!matchPatternAt(rom, at, head)) {
			continue;
		}
		let text = '';
		for (let k = 0; k < SYSTEM_INFO_SIZE; k++) {
			const byte = rom[at + k];
			text += (byte >= 0x20 && byte < 0x7f) ? String.fromCharCode(byte) : ' ';
		}
		found.push({offset: at, text: text.trim()});
	}

	return found;
}

// --------------------------------
// the patch
// --------------------------------

// Returns a new Uint8Array; the input is never modified.
//   options.loadAddr     the 16 bit RAM address of the dumper (default: read out of the bulk dump table)
//   options.ramPage      the page that address sits in       (default: detected)
//   options.freeOffset   where to put the trampoline         (default: detected)
//   options.paramNo      patch only the entry with this parameter number (default: every entry found)
export function patchRom(rom, options = {}) {
	if (!(rom instanceof Uint8Array)) {
		rom = new Uint8Array(rom);
	}
	// Patch the image the right way round, then hand it back the way it came in, so that what was burned before can be
	// burned again the same way. analyzeRom() is the one that decides which way round it is.
	const info = analyzeRom(rom);
	if (info.isSwapped) {
		rom = swapBytes(rom);
	}

	if (!info.hook.isOk) {
		throw patchError(info.hook.reasonCode, info.hook);
	}
	if (!info.bulk.isOk) {
		throw patchError(info.bulk.reasonCode, info.bulk);
	}
	if (!info.entries.isOk) {
		throw patchError(info.entries.reasonCode, info.entries);
	}
	if (!info.ramPage.isOk && options.ramPage === undefined) {
		throw patchError(info.ramPage.reasonCode, info.ramPage);
	}
	if (!info.stub.isOk) {
		throw patchError(info.stub.reasonCode, info.stub);
	}

	const page = (options.ramPage !== undefined) ? options.ramPage : info.ramPage.page;
	const ramAddr = (options.loadAddr !== undefined) ? options.loadAddr : info.bulk.load.addr;
	if (page < 0 || page > 0xff || ramAddr < 0 || ramAddr > 0xffff) {
		throw patchError('load-address-out-of-range', {ramPage: page, loadAddr: ramAddr});
	}
	const addr = (page << 16) | ramAddr;

	const bank = info.hook.write & ~0xffff;
	const handlerAddr = info.hook.write & 0xffff;
	const at = (options.freeOffset === undefined) ? info.stub.at : options.freeOffset;
	if ((at & ~0xffff) !== bank) {
		throw patchError('trampoline-outside-bank', {at, bank});
	}
	if (at + TRAMPOLINE_SIZE > rom.length) {
		throw patchError('trampoline-does-not-fit', {at, neededSize: TRAMPOLINE_SIZE, size: rom.length});
	}

	const targets = (options.paramNo === undefined)
		? info.entries.list
		: info.entries.list.filter((entry) => (entry.paramNo === options.paramNo));
	if (targets.length === 0) {
		throw patchError('no-entry-with-that-parameter-number', {paramNo: options.paramNo});
	}

	const stub = buildTrampoline(addr, handlerAddr);
	const beforeStub = rom.slice(at, at + TRAMPOLINE_SIZE);

	const out = rom.slice();
	out.set(stub, at);
	const written = [];
	for (const entry of targets) {
		written.push({
			offset: entry.offset,
			paramNo: entry.paramNo,
			replaced: rom.slice(entry.offset, entry.offset + 2),
			written: Uint8Array.from([(at >> 8) & 0xff, at & 0xff]),
		});
		out[entry.offset] = (at >> 8) & 0xff;
		out[entry.offset + 1] = at & 0xff;
	}

	// Only these runs are ever written, so they are all that has to be compared to know whether the output is the input.
	const isSame = (before, after) => (before.length === after.length && before.every((e, i) => (e === after[i])));
	const isUnchanged = isSame(beforeStub, stub) &&
		written.every((one) => isSame(one.replaced, one.written));

	const emitted = (info.isSwapped) ? swapBytes(out) : out;

	return {
		rom: emitted, info, loadAddr: addr, ramPage: page,
		entries: written, handler: bank + handlerAddr, trampolineAt: at,
		stub, stubReplaced: beforeStub, isPatched: info.stub.isPatched, isUnchanged,
		isSwapped: info.isSwapped,
		crc32: calcCrc32(emitted),
	};
}

// Why the patch could not be made, as an Error a caller can read rather than print. The message is the code itself,
// so a throw that nobody catches is still traceable; `details` carries the numbers behind it.
function patchError(reasonCode, details) {
	return Object.assign(new Error(reasonCode), {reasonCode, details});
}

// The magic word is read through DP, and what DP holds when the handler is called is the firmware's business, not ours.
// So the stub sets DP itself and puts it back. BNE skips the PJSR only, so the restore always runs.
//
//   STC.B  DP,@-SP / LDC.B #ramPage,DP / CMP:G.W #MAGIC_WORD,@magicAddr:16
//   BNE .+4 / PJSR @loadAddr / LDC.B @SP+,DP / JMP @original
function buildTrampoline(loadAddr, originalHandler) {
	const magicAddr = (loadAddr + 2) & 0xffff;
	const stub = new Uint8Array([
		0xb7, 0x9d,
		0x04, (loadAddr >> 16) & 0xff, 0x8d,
		0x1d, (magicAddr >> 8) & 0xff, magicAddr & 0xff, 0x05, (MAGIC_WORD >> 8) & 0xff, MAGIC_WORD & 0xff,
		0x26, 0x04,
		0x03, (loadAddr >> 16) & 0xff, (loadAddr >> 8) & 0xff, loadAddr & 0xff,
		0xc7, 0x8d,
		0x10, (originalHandler >> 8) & 0xff, originalHandler & 0xff,
	]);
	console.assert(stub.length === TRAMPOLINE_SIZE, 'the stub must be as long as the space reserved for it');

	return stub;
}
