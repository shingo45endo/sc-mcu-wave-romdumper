;==========================================================================
; sc-mcu-wave-romdumper - payload for models whose main CPU puts the bytes on MIDI Out itself
;
; Models:
;   SC-55 (all versions), SC-155, SC-33, SCC-1, DS-330, SD-35, RA-30, CM-300, XP-10
;
; Body and transmit module, in that order. Everything model specific is either in the file table or in the module.
;
; Assemble with the Macroassembler AS, or just run "make":
;
;   asl -cpu HD6475328 -i src -o build/dumper_maincpu.p src/dumper_maincpu.asm
;   p2bin build/dumper_maincpu.p build/dumper_maincpu.bin -r '$-$' -l 0
;==========================================================================

		cpu	HD6475328
		maxmode	on
		assume	dp:0,ep:0,tp:0,br:0

		include	dumper.inc
		include	dumper_body.inc

;--------------------------------------------------------------------------
; The module starts on a bulk dump block boundary, so that a loader message never straddles the seam between the body
; and the module.
;--------------------------------------------------------------------------
		if	*>LOADADDR+TXOFS
		 fatal  "the body has grown past TXOFS - raise it in dumper.inc"
		endif

		org	LOADADDR+TXOFS

		include	tx_maincpu.inc

;--------------------------------------------------------------------------
; The module has to stay clear of the file table.
;--------------------------------------------------------------------------
		if	*>LOADADDR+TABLEOFS
		 fatal	"the transmit module has grown past TABLEOFS - raise it in dumper.inc"
		endif

		org	LOADADDR+TABLEOFS

		end
