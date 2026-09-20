import {DEFAULT_DEVICE_ID, buildWriteMessage} from '../lib/gs_message.js';

const BLOCK_SIZE = 0x40;	// bulk dump address granularity
const MAX_BLOCK = 15;

// Which block a drum map address selects. The SC-55 family's handler swaps the first four around; the SC-88 family's
// leaves them alone. Named rather than defaulted, because loading a dumper at the wrong address is silent.
const BLOCK_ORDERS = {
	sc55: {0: 2, 1: 3, 2: 0, 3: 1},
	sc88: {},
};
console.assert(
	Object.entries(BLOCK_ORDERS.sc55).every(([blockNo, nibble]) => (BLOCK_ORDERS.sc55[nibble] === Number(blockNo))),
	'the block swizzle must be its own inverse',
);

export function getBlockOrderNames() {
	return Object.keys(BLOCK_ORDERS);
}

// One message per 64-byte block of `image`, loaded at `start` bytes into the drum map. `start` has to be a multiple of 64.
export function buildBulkMessages(image, start = 0, {mapNo = 1, blockOrder, device = DEFAULT_DEVICE_ID} = {}) {
	const nibbleOf = BLOCK_ORDERS[blockOrder];
	if (!nibbleOf) {
		throw new Error(`blockOrder must be one of: ${getBlockOrderNames().join(', ')}`);
	}
	if (start % BLOCK_SIZE) {
		throw new Error('the load offset must be a multiple of 64');
	}

	const messages = [];
	for (let i = 0; i < image.length; i += BLOCK_SIZE) {
		const blockNo = (start + i) / BLOCK_SIZE;
		if (blockNo > MAX_BLOCK) {
			throw new Error(`block ${blockNo} is past the ${MAX_BLOCK + 1} the handler can address`);
		}
		const mm = (mapNo << 4) | ((blockNo in nibbleOf) ? nibbleOf[blockNo] : blockNo);
		messages.push(buildWriteMessage([0x49, mm, 0x00], image.slice(i, i + BLOCK_SIZE), {device}));
	}

	return messages;
}
