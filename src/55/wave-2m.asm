;==========================================================================
; File table - 2 MiB, the first slot only, and no MCU internal ROM
;
; Models:
;   - Roland PMA-5
;
;   asl -cpu HD6475328 -i src -o build/wave-2m.p src/wave-2m.asm
;==========================================================================

		cpu	HD6475328
		maxmode	on
		assume	dp:0,ep:0,tp:0,br:0

		include	dumper.inc

		org	LOADADDR+TABLEOFS

		IOEND

		FILE	SRC_PCM,$000000,$200000,'WAVE_00.BIN'

		TABLEEND

		end
