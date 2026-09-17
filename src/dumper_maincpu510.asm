;==========================================================================
; sc-mcu-wave-romdumper - payload for H8/510 models whose main CPU puts the bytes on MIDI Out itself
;
; Models:
;   RA-30, XP-10, PMA-5
;
; Body, transmit module and wave ROM read module, in that order. Everything model specific is either in the file
; table or in one of the modules.
;
; The H8/532 models use the same body and the same module, at different SCI addresses. See dumper_maincpu532.asm.
;
; Assemble with the Macroassembler AS, or just run "make":
;
;   asl -cpu HD6475328 -i src -o build/dumper_maincpu510.p src/dumper_maincpu510.asm
;   p2bin build/dumper_maincpu510.p build/dumper_maincpu510.bin -r '$-$' -l 0
;==========================================================================

		cpu	HD6475328
		maxmode	on
		assume	dp:0,ep:0,tp:0,br:0

		include	dumper.inc
		include	dumper_body.inc

;--------------------------------------------------------------------------
; The modules start on a bulk dump block boundary, so that a loader message never straddles the seam between the body
; and the modules.
;--------------------------------------------------------------------------
		if	*>LOADADDR+TXOFS
		 fatal  "the body has grown past TXOFS - raise it in dumper.inc"
		endif

		org	LOADADDR+TXOFS

; Where the H8/510 keeps its SCI. Channel 0: the firmware never transmits on channel 1, so MIDI Out is this one.
SSR		equ	$FECC				; SCI status  (bit 7 = TDRE)
TDR		equ	$FECB				; SCI transmit data

		include	tx_maincpu.inc
		include	rd_pcm510.inc

;--------------------------------------------------------------------------
; The modules have to stay clear of the file table.
;--------------------------------------------------------------------------
		if	*>LOADADDR+TABLEOFS
		 fatal	"the modules have grown past TABLEOFS - raise it in dumper.inc"
		endif

		org	LOADADDR+TABLEOFS

		end
