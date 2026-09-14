;==========================================================================
; File table - 2 MiB in each of the first two slots
;
; Models:
;   - Roland XP-10
;
;   asl -cpu HD6475328 -i src -o build/wave-2m2m.p src/wave-2m2m.asm
;==========================================================================

		cpu	HD6475328
		maxmode	on
		assume	dp:0,ep:0,tp:0,br:0

		include	dumper.inc

		org	LOADADDR+TABLEOFS

		IOEND

		FILE	SRC_PCM,$000000,$200000,'WAVE_00.BIN'
		FILE	SRC_PCM,$200000,$200000,'WAVE_20.BIN'

		TABLEEND

		end
