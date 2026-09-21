// One file out of a dump, whichever way it arrived:
//
//   {name, size, received, packets, errors, isComplete, bytes}
//
// A MIDI File Dump already has this shape, one entry per file. A bulk dump is one file spread over many passes, so
// what the passes say about themselves - a pass that complained, a gap nothing covered - becomes that file's errors.

export function getFileDumpResults(receiver) {
	return receiver.getResults().map((file) => ({
		name: file.name,
		size: file.size,
		received: file.received,
		packets: file.packets,
		errors: file.errors,
		isComplete: file.isComplete,
		bytes: file.bytes,
	}));
}

// `size` and `name` override what the file header said, for a capture that never carried one.
export function getBulkDumpResult(receiver, {size, name} = {}) {
	const result = receiver.getResult({size, name});
	const errors = [...receiver.errors];
	for (const pass of receiver.getProperties()) {
		for (const problem of pass.problems) {
			errors.push(`pass ${pass.passNo}: ${problem}`);
		}
	}
	for (const hole of result.holes) {
		errors.push(`nothing covers ${hole.size} bytes at H'${hole.at.toString(16).toUpperCase()}`);
	}
	const missingBytes = result.holes.reduce((total, hole) => (total + hole.size), 0);

	return {
		name: result.name,
		size: result.size,
		received: result.size - missingBytes,
		packets: receiver.packets,
		errors,
		isComplete: result.isComplete,
		bytes: result.bytes,
	};
}
