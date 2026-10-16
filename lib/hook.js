// The hook the two patchers share: how the dumper says it is loaded, and the message that calls it.

import {DEFAULT_DEVICE_ID, buildWriteMessage} from './gs_message.js';

// Word the dumper puts at LOADADDR+2 so a hook can tell it is loaded. "coda" - the musical jump-here mark.
export const MAGIC_WORD = 0xc0da;

// The GS message that fires the hook: DT1 to 40 10 17.
// 08 00 is the middle of the range this parameter accepts, so firing the hook does not change the sound.
export function triggerMessage({device = DEFAULT_DEVICE_ID} = {}) {
	return buildWriteMessage([0x40, 0x10, 0x17], [0x08, 0x00], {isNibble: false, device});
}
