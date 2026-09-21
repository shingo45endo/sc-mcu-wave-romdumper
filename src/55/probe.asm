;==========================================================================
; File table - probe pass, for a model whose wave ROM layout is unknown
;
; What it dumps:
;   - 112 bytes from each 512 KiB boundary across the first 8 MiB of the PCM chip's address space
;     (H'1000 into each window, past the 32-byte Roland header every wave ROM starts with,
;     so a boundary read is not just the same shared bytes on every device).
;   - One window at address 0, to check the header text once converted to a ROM image.
;   - The MCU's internal ROM.
;   - About 2.9 kB of MIDI; a second to run.
;
; How to read the result:
;   - All bytes equal (H'FF)  - nothing is mapped there.
;   - Equal to another window - a mirror; the spacing is the real device size, and the first mirror marks its top.
;   - Anything else           - a populated, distinct part of a device.
;   - Example: an SC-55 reads distinct, distinct, mirror, mirror, repeated three times - three 1 MiB devices,
;     each in its own 2 MiB slot.
;
;   cli/probe.js reads the capture automatically. W000000.BIN, converted to a ROM image, should read "Roland ..." -
;   that confirms both that a wave ROM is there and that the model scrambles the way this project expects.
;
;   asl -cpu HD6475328 -i src -o build/probe.p src/probe.asm
;==========================================================================

		cpu	HD6475328
		maxmode	on
		assume	dp:0,ep:0,tp:0,br:0

		include	dumper.inc

		org	LOADADDR+TABLEOFS

; Nothing poked. If a model turns out to need a bank register set, add
;   IOWRITE $E03D,$20
; here and probe again.
		IOEND

; The MCU internal ROM is read even though the machine may not have one:
; that read is itself the test. If what comes back is the first 32 KiB of
; the external ROM you just patched, the CPU is an H8/510 and has no internal ROM.
; Drop the entry from the table probe.js writes, with --mcu left off, once you know.
		FILE	SRC_MCU,$000000,$008000,'MCU.BIN'
		FILE	SRC_PCM,$000000,$000070,'HEADER.BIN'  ; address 0, to check the scrambling
		FILE	SRC_PCM,$001000,$000070,'W000000.BIN' ; One window per 512 KiB step, read H'1000 in.
		FILE	SRC_PCM,$081000,$000070,'W080000.BIN'
		FILE	SRC_PCM,$101000,$000070,'W100000.BIN'
		FILE	SRC_PCM,$181000,$000070,'W180000.BIN'
		FILE	SRC_PCM,$201000,$000070,'W200000.BIN'
		FILE	SRC_PCM,$281000,$000070,'W280000.BIN'
		FILE	SRC_PCM,$301000,$000070,'W300000.BIN'
		FILE	SRC_PCM,$381000,$000070,'W380000.BIN'
		FILE	SRC_PCM,$401000,$000070,'W400000.BIN'
		FILE	SRC_PCM,$481000,$000070,'W480000.BIN'
		FILE	SRC_PCM,$501000,$000070,'W500000.BIN'
		FILE	SRC_PCM,$581000,$000070,'W580000.BIN'
		FILE	SRC_PCM,$601000,$000070,'W600000.BIN'
		FILE	SRC_PCM,$681000,$000070,'W680000.BIN'
		FILE	SRC_PCM,$701000,$000070,'W700000.BIN'
		FILE	SRC_PCM,$781000,$000070,'W780000.BIN'

		TABLEEND

		end
