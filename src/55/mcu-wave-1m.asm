;==========================================================================
; File table - 1 MiB, the first slot only
;
; Models:
;   - Roland SD-35
;
;   asl -cpu HD6475328 -i src -o build/mcu-wave-1m.p src/mcu-wave-1m.asm
;==========================================================================

		cpu	HD6475328
		maxmode	on
		assume	dp:0,ep:0,tp:0,br:0

		include	dumper.inc

		org	LOADADDR+TABLEOFS

		IOEND

		FILE	SRC_MCU,$000000,$008000,'MCU.BIN'
		FILE	SRC_PCM,$000000,$100000,'WAVE_00.BIN'

		TABLEEND

		end
