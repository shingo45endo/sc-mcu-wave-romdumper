// Checking the system information blocks a catalogue claims, for every family's generator.
//
// The blocks are what names a synth, and both things that can go wrong with them are silent: an editor that trims
// the trailing spaces off a readable entry breaks every match, and a block that two wave ROM layouts both claim has
// one of them picked for it. So the build stops rather than publish either.

import {toSystemInfoBlock} from '../lib/identify.js';

const BLOCK_SIZE = 32;

// `seen` maps a block to the {key, config} that claimed it, and is carried across every model and every family.
export function checkSystemInfo(key, entries, config, seen) {
	for (const entry of entries) {
		const isHexEncoded = ((entry.length === 64) && (/^[0-9a-fA-F]{64}$/u).test(entry));
		if (!isHexEncoded && entry.length !== BLOCK_SIZE) {
			throw new Error(`${key}: systemInfo ${JSON.stringify(entry)} is ${entry.length} characters, ` +
				`not the ${BLOCK_SIZE} bytes the synth returns (or 64 hex digits)`);
		}
		// Two models sharing a block is fine - the SC-55 and the SC-155 do - as long as they agree about the layout.
		// Both spellings of the same bytes have to land on the same key, so the hex form is decoded first.
		const block = toSystemInfoBlock(entry);
		const owner = seen.get(block);
		if (owner && owner.config !== config) {
			throw new Error(`${key}: systemInfo ${JSON.stringify(entry)} is also ${owner.key}'s, ` +
				`but ${key} is ${config} and ${owner.key} is ${owner.config}. ` +
				'One block cannot name two wave ROM layouts');
		}
		seen.set(block, {key, config});
	}
}

// What a published table has already claimed, so a generator that runs second can see the first one's models.
export function readClaimedBlocks(models) {
	const seen = new Map();
	for (const [key, model] of Object.entries(models ?? {})) {
		for (const entry of model.systemInfo ?? []) {
			seen.set(toSystemInfoBlock(entry), {key, config: model.config});
		}
	}

	return seen;
}
