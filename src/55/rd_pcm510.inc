;==========================================================================
; Wave ROM read module: the PCM chip's read port, as the H8/510 models decode it
;
; The same three registers as rd_pcm532.inc, in the same order, at a window H'1F80 higher.
;
; These are board addresses, not CPU addresses. A new model needs its read routine checked, not assumed.
;
; Included from dumper_maincpu510.asm. See dumper_body.inc for the entry point, and tx_maincpu.inc for the branch
; table that holds it.
;==========================================================================

PCMAH		equ	$FFA1		; wave ROM address A23-A16
PCMAL		equ	$FFA2		; wave ROM address A15-A0
					;   (the write to A7-A0 fetches)
PCMDAT		equ	$FFBF		; wave ROM read-back latch

;--------------------------------------------------------------------------
; pcmread: R0 = the wave ROM byte at R2:R1
;--------------------------------------------------------------------------
pcmread:	STC.W	SR,@-SP				; Save the mask rather than clear it, so that
		ORC.W	#$0700,SR			;   one read module fits every transmit module.
		MOV:G.B	R2,@PCMAH:16			; A23-A16
		MOV:G.W	R1,@PCMAL:16			; A15-A0
		MOV:G.B	@PCMDAT:16,R0
		LDC.W	@SP+,SR
		RTS
