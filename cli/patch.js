#!/usr/bin/env node
/*
	Command line front end for patcher.js.

	  node cli/patch.js <rom.bin> [-o out.bin] [--addr 8CD4] [-n]

	  -o, --out     where to write the patched ROM (default: <rom>_patched.bin)
	  --addr        RAM address to jump to, hex (default: H'8CD4, the drum set 2 area, which is the same on every model checked)
	  --offset      ROM offset to patch, hex (default: detected)
	  -n, --dry-run analyse only, write nothing
*/

import fs from 'node:fs';
import process from 'node:process';
import util from 'node:util';

import {toHex, toHexBytes} from '../lib/format.js';
import {analyzeRom, patchRom, triggerSysEx, MAGIC_WORD} from '../lib/patcher.js';

const REASON_TEXTS = {
	'handler-not-found':
		() => 'the DT1 nibble handler was not found. Is this really an H8/500-based Sound Canvas ROM?',
	'handler-ambiguous':
		(d) => `the DT1 nibble handler pattern matched ${d.matchCount} times - ambiguous.`,
	'handler-entry-not-found':
		() => 'found the handler body but not its entry (no "RTS / ADD:G.W #2,R5" in front of it)',
	'no-hook':
		() => 'no hook',
	'table-not-found':
		() => 'the DT1 handler jump table was not found',
	'table-ambiguous':
		(d) => `found ${d.candidateCount} possible jump table entries - too many to choose safely.`,
	'no-table-entry':
		() => 'no jump table entry',
	'bank-has-no-free-run':
		(d) => `H'${toHex(d.fixedAt, 5)} is not free, and its bank has no run of ${d.neededSize} free (H'FF) bytes.`,
	'free-run-too-short':
		(d) => `this bank's longest free run is ${d.runSize} bytes; ${d.neededSize} are needed.`,
	'load-address-out-of-range':
		() => 'load address must fit in 20 bits',
	'trampoline-outside-bank':
		() => 'the trampoline must be in the same bank as the handler',
	'trampoline-does-not-fit':
		() => 'trampoline does not fit',
};

function getReasonText(what) {
	const text = REASON_TEXTS[what.reasonCode];
	return (text) ? text(what) : String(what.reasonCode);
}

// A human readable summary of analyzeRom() / patchRom().
function describeAnalysis(result) {
	const info = result.info || result;
	const lines = [];
	lines.push(`size            ${info.size} bytes (${(info.size / 1024) | 0} KiB)`);
	lines.push(`CRC32           ${toHex(info.crc32, 8)}`);
	if (info.version) {
		lines.push(`version string  ${info.version.text}`);
	}

	if (info.hook.isOk) {
		lines.push(`hook site       H'${toHex(info.hook.offset, 5)}  (DT1 handler for 40 1x 17)`);
	} else {
		lines.push(`hook site       NOT FOUND - ${getReasonText(info.hook)}`);
	}

	if (info.hook.isOk && info.table && !info.table.isOk) {
		lines.push(`jump table      NOT FOUND - ${getReasonText(info.table)}`);
		if (info.hasUnknownPatch) {
			lines.push("                this image also holds the dumper's magic word, so");
			lines.push('                something has patched it in a way this tool does not');
			lines.push('                recognize. Start over from an unmodified ROM.');
		}
	} else if (info.table && info.table.isOk) {
		lines.push(`jump table      H'${toHex(info.table.start, 5)}, ` +
			`${info.table.entries} entries; ours at H'${toHex(info.table.offset, 5)}`);
	}
	if (info.stub && info.stub.isOk) {
		const freeRunText = `${info.stub.runSize} bytes of H'FF`;
		const why = {
			existing: 'already patched; the stub is there',
			fixed: `the fixed address; ${freeRunText}`,
			searched: `H'${toHex(info.stub.fixedAt, 5)} is taken here, so the bank was searched; ${freeRunText}`,
		}[info.stub.how];
		lines.push(`stub address    H'${toHex(info.stub.at, 5)}  (${why})`);
	} else if (info.table && info.table.isOk && info.stub && info.stub.reasonCode) {
		// when the table itself was not found, the line above says why
		lines.push(`stub address    NOT FOUND - ${getReasonText(info.stub)}`);
	}

	if (result.rom) {
		lines.push('');
		lines.push(`jump table      H'${toHex(result.tableEntry, 5)}: ` +
			`${toHexBytes(result.replaced)} -> ${toHexBytes(result.written)}`);
		lines.push(`trampoline at   H'${toHex(result.trampolineAt, 5)}`);
		const s = result.stub;
		lines.push(`  ${toHexBytes(s.slice(0, 6)).padEnd(18)}CMP:G.W #H'${toHex(MAGIC_WORD, 4)},` +
			`@H'${toHex((result.loadAddr + 2) & 0xffff, 4)}:16`);
		lines.push(`  ${toHexBytes(s.slice(6, 8)).padEnd(18)}BNE     .+4`);
		lines.push(`  ${toHexBytes(s.slice(8, 12)).padEnd(18)}PJSR    @H'${toHex(result.loadAddr, 5)}`);
		lines.push(`  ${toHexBytes(s.slice(12, 15)).padEnd(18)}JMP     @H'${toHex(result.handler & 0xffff, 4)}`);
	}
	if (result.rom) {
		lines.push(`CRC32 after     ${toHex(result.crc32, 8)}${
			(result.isUnchanged) ? '  (unchanged: it was already patched like this)' : ''}`);
		lines.push('');
		lines.push(`trigger SysEx   ${toHexBytes(triggerSysEx())}`);
	}

	return lines.join('\n');
}

function printUsageAndExit(message) {
	if (message) {
		process.stderr.write(`patch: ${message}\n\n`);
	}
	process.stderr.write('usage: node cli/patch.js <rom.bin> [-o out.bin] [--addr HHHH]\n' +
		'                          [--free HHHHH] [-n]\n');

	process.exit((message) ? 2 : 0);
}

function parseAddrOption(name) {
	if (values[name] === undefined) {
		return undefined;
	}
	const text = values[name].replace(/^(0x|H')/iu, '');
	if (!/^[0-9a-f]+$/iu.test(text)) {
		printUsageAndExit(`--${name} wants a hex address, not "${values[name]}"`);
	}

	return parseInt(text, 16);
}

// Read the command-line arguments.
const args = process.argv.slice(2);
if (args.length === 0) {
	printUsageAndExit();
}
let values, positionals;
try {
	({values, positionals} = util.parseArgs({
		args,
		options: {
			'help': {type: 'boolean', short: 'h'},
			'out': {type: 'string', short: 'o'},
			'addr': {type: 'string'},
			'offset': {type: 'string'},
			'free': {type: 'string'},
			'mode': {type: 'string', default: 'trampoline'},
			'dry-run': {type: 'boolean', short: 'n', default: false},
		},
		allowPositionals: true,
	}));
} catch (e) {
	printUsageAndExit(e.message);
}
if (values.help) {
	printUsageAndExit();
}
const {out} = values;
const isDryRun = values['dry-run'];

const addr = parseAddrOption('addr');
const free = parseAddrOption('free');

if (positionals.length > 1) {
	printUsageAndExit('more than one input file');
}
const input = positionals[0];
if (input === undefined) {
	printUsageAndExit('no input file');
}

// Read the ROM file.
let rom;
try {
	rom = new Uint8Array(fs.readFileSync(input));
} catch (e) {
	printUsageAndExit(`cannot read ${input}: ${e.message}`);
}

// Analyse the ROM, and stop here for a dry run.
if (isDryRun) {
	const info = analyzeRom(rom);
	process.stdout.write(`${describeAnalysis(info)}\n`);
	// An image this could not be patched is a failure to report, whether it is the hook, the table or the room for the
	// stub that is missing.
	process.exit((info.isReady) ? 0 : 1);
}

// Patch it.
let result;
try {
	result = patchRom(rom, {
		...((addr !== undefined) ? {loadAddr: addr} : {}),
		...((free !== undefined) ? {freeOffset: free} : {}),
	});
} catch (e) {
	// patchRom() says why with a code; anything else really is an exception
	process.stderr.write(`patch: ${
		(e.reasonCode) ? getReasonText({reasonCode: e.reasonCode, ...e.details}) : e.message}\n`);
	process.exit(1);
}

// Print the report.
process.stderr.write(`${describeAnalysis(result)}\n`);

// A byte for byte copy of the input under a second _patched is a file nobody wants, so say what is true instead:
// it is already done.
if (result.isUnchanged) {
	process.stderr.write(`\npatch: already patched at H'${toHex(result.trampolineAt, 5)} -- nothing to write\n`);
	process.stderr.write(`trigger with: ${toHexBytes(triggerSysEx())}\n`);
	process.exit(0);
}

// Write the patched ROM.
const target = out || input.replace(/(\.[^./\\]+)?$/u, '_patched$1');
fs.writeFileSync(target, result.rom);
process.stderr.write(`\nwrote ${target}\n`);
process.stderr.write(`trigger with: ${toHexBytes(triggerSysEx())}\n`);
