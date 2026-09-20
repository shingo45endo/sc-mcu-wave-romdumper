// Where each pass of an SC-88 family wave ROM dump starts.
//
// One call of the dumper reads a fixed number of bytes into the buffer, and the host reads the buffer back. That is
// a pass. A pass must not cross a 1 MiB bank, because the dumper writes the bank register once per call.
//
// A bank is not a whole number of passes, so the last pass of each bank is moved back to end on the boundary and
// reads part of the one before it again. Every pass is placed by its own offset, so the overlap costs a little time
// and nothing else.
//
// Nothing here depends on a reply, so the host can write the whole sequence out in advance.

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
