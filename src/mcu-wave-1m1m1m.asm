;==========================================================================
; File table - 1 MiB in each of the first three 2 MiB slots
;
; Models:
;   - Roland SC-55 (all versions)
;	- Roland SC-155
;
;   asl -cpu HD6475328 -i src -o build/mcu-wave-1m1m1m.p src/mcu-wave-1m1m1m.asm
;==========================================================================

		cpu	HD6475328
		maxmode	on
		assume	dp:0,ep:0,tp:0,br:0

		include	dumper.inc

		org	LOADADDR+TABLEOFS

		IOEND

		FILE	SRC_MCU,$000000,$008000,'MCU.BIN'
		FILE	SRC_PCM,$000000,$100000,'WAVE_00.BIN'
		FILE	SRC_PCM,$200000,$100000,'WAVE_20.BIN'
		FILE	SRC_PCM,$400000,$100000,'WAVE_40.BIN'

		TABLEEND

		end
