;==========================================================================
; Transmit module: the main CPU, through its own SCI
;
; What every model uses whose MIDI Out is on the CPU's own serial port. Sending a byte is one write to TDR, once TDRE
; says the shift register is free.
;
; The two registers are NOT at the same addresses on every CPU in this family, so the payload names them:
;
;	H8/532	SSR H'FFDC  TDR H'FFDB
;	H8/510	SSR H'FECC  TDR H'FECB   (its SCI channel 0; channel 1 never transmits)
;
; Interrupts stay masked for the whole dump. The firmware's active sensing interrupt writes TDR directly and would land
; in the middle of ours. That is safe because none of these firmwares ever programmes the watchdog.
;
; Included from dumper_maincpu532.asm and dumper_maincpu510.asm. See dumper_body.inc for the five entry points and
; why they are branches. The fifth is the wave ROM read, which a separate module provides; the branch to it is here
; because the table has to start at the top of the first module.
;==========================================================================

; Poll the wrong address and the loop below never ends, so stop the build instead of shipping a payload that hangs.
		ifndef	SSR
		 fatal	"the payload has to define SSR - it is not at the same address on the H8/532 and the H8/510"
		endif
		ifndef	TDR
		 fatal	"the payload has to define TDR - it is not at the same address on the H8/532 and the H8/510"
		endif

txopen:		BRA	sciopen
txs:		BRA	scitxs
tx:		BRA	scitx
txclose:	BRA	sciclose
rdpcm:		BRA	pcmread				; in the read module, which follows this one

sciopen:	ORC.W	#$0700,SR			; Mask interrupts for the whole dump.
		RTS

;--------------------------------------------------------------------------
; scitxs: send R0 and fold it into the checksum
; scitx:  polled SCI transmit
;--------------------------------------------------------------------------
scitxs:		MOV:G.W	R1,@-SP
		MOV:F.B	@(V_CSUM,FP),R1
		XOR:G.B	R0,R1				; The packet checksum is an XOR.
		MOV:F.B	R1,@(V_CSUM,FP)
		MOV:G.W	@SP+,R1
scitx:		BTST.B	#7,@SSR:16			; TDRE: is the shift register free?
		BEQ	scitx				; Poll until it is.
		MOV:G.B	R0,@TDR:16
		BCLR.B	#7,@SSR:16			; Clear TDRE, as the H8 asks.
		RTS

sciclose:	ANDC.W	#$F8FF,SR			; interrupts back on
		RTS
