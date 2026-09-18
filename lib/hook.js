// The hook the two patchers share: how the dumper says it is loaded, and the message that calls it.

// Word the dumper puts at LOADADDR+2 so a hook can tell it is loaded. "coda" - the musical jump-here mark.
export const MAGIC_WORD = 0xc0da;

// The GS message that fires the hook: DT1 to 40 10 17.
// 08 00 is the middle of the range this parameter accepts, so firing the hook does not change the sound.
export function triggerSysEx({deviceId = 0x10} = {}) {
	const addr = [0x40, 0x10, 0x17];
	const data = [0x08, 0x00];
	let sum = 0;
	for (const byte of [...addr, ...data]) {
		sum = (sum + byte) & 0x7f;
	}
	const checksum = (128 - sum) & 0x7f;

	return new Uint8Array([0xf0, 0x41, deviceId & 0x7f, 0x42, 0x12, ...addr, ...data, checksum, 0xf7]);
}
