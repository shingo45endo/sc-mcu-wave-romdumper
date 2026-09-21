// `windows` is the probe's windows in address order, each already classified as {base, isConstant, mirrorOf};
// `step` is the spacing between them. Returns [{base, size}] in address order.
export function findDevices(windows, step) {
	const periodByBase = findPeriods(windows);
	const devices = [];
	for (let i = 0; i < windows.length;) {
		if (windows[i].isConstant || windows[i].mirrorOf !== undefined) {
			i++;
			continue;
		}
		const from = windows[i].base;
		while (i < windows.length && !windows[i].isConstant &&
			windows[i].mirrorOf === undefined) {
			i++;
		}
		const to = (i < windows.length)
			? windows[i].base : windows[i - 1].base + step;
		devices.push(...splitRun(from, to, periodByBase));
	}
	return devices;
}

// base -> the size its first mirror implies
function findPeriods(windows) {
	const periodByBase = new Map();
	for (const window of windows) {
		if (window.mirrorOf !== undefined && !periodByBase.has(window.mirrorOf)) {
			periodByBase.set(window.mirrorOf, window.base - window.mirrorOf);
		}
	}
	return periodByBase;
}

// One run of populated windows, cut at every address something mirrors.
function splitRun(from, to, periodByBase) {
	const seams = [...periodByBase.keys()].filter((base) => (base > from && base < to)).
		sort((a, b) => a - b);
	const segments = [];
	for (let at = from; at < to;) {
		const size = periodByBase.get(at) ?? (seams.find((base) => (base > at)) ?? to) - at;
		segments.push({base: at, size});
		at += size;
	}
	return segments;
}

// A mask ROM is a power of two. Anything else means the windows are too far apart to have caught a seam,
// and the size is really two devices or more.
export function isPlausibleSize(size) {
	return size > 0 && (size & (size - 1)) === 0;
}
