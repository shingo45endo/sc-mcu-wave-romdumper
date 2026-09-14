;==========================================================================
; File table - 2 MiB in the first slot, 1 MiB in the second
;
; Models:
;   - Roland SC-55mkII, SC-55ST
;
;   asl -cpu HD6475328 -i src -o build/mcu-wave-2m1m.p src/mcu-wave-2m1m.asm
;==========================================================================

		cpu	HD6475328
		maxmode	on
		assume	dp:0,ep:0,tp:0,br:0

		include	dumper.inc

		org	LOADADDR+TABLEOFS

		IOEND

		FILE	SRC_MCU,$000000,$008000,'MCU.BIN'
		FILE	SRC_PCM,$000000,$200000,'WAVE_00.BIN'
		FILE	SRC_PCM,$200000,$100000,'WAVE_20.BIN'

		TABLEEND

		end
