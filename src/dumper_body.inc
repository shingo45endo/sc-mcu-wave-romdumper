;==========================================================================
; sc-mcu-wave-romdumper - RAM resident payload, the part every model shares
;
; Loaded into spare RAM (the drum set 2 parameter area) with GS bulk dump SysEx. Then entered with PJSR,
; from a small per-model hook in the external firmware ROM. One call dumps every file in the separately loaded table -
; the MCU's internal ROM and the wave ROMs, back to back.
;
; This file holds no model-specific address. What the models differ in is
;
;   * the file table, a separate binary at LOADADDR+TABLEOFS
;   * the five-byte ROM hook
;   * how a byte reaches MIDI Out, which is a transmit module appended
;     after this one - see dumper_maincpu532.asm, dumper_maincpu510.asm and dumper_subcpu.asm
;   * where the wave ROM read port is, which is a read module appended
;     after the transmit module - see rd_pcm532.inc
;
;   * reads the MCU internal ROM straight out of page 0
;   * reads the wave ROM through the read module
;   * position independent - it recovers its own address at run time
;
; What this expects of the modules:
;
;   txopen   called once before any output. Whatever the module needs the
;            machine to be in for the whole dump, it does here
;   txs      send R0 and fold it into the running checksum
;   tx       send R0. Every register except R0 comes back untouched
;   txclose  called once after the last byte
;   rdpcm    R0 = the wave ROM byte at R2:R1. Every register except R0
;            comes back untouched
;
; Those five are branches at the very top of the transmit module, in that order. So they sit at the same five
; addresses whichever modules are appended. That is what keeps this file the same on every model, byte for byte:
; the calls below encode a fixed displacement, and without the branches it would be a different displacement per module.
;
; The module is appended after this file, so it lands past CODEEND and is not covered by the disassembly check.
;
; Output follows the MIDI universal SysEx File Dump, open loop (there is no
; handshake - nothing is listening on MIDI In). Per file:
;
;   F0 7E 7F 07 01 7F 'BIN ' <length,4x7bit LSB first> <name> F7
;   F0 7E 7F 07 02 <pkt> 7F <16 x (msb + 7 x data7)> <xor> F7   ... x N
;
; Each data packet carries GROUPS*7 = 112 file bytes. The last packet of a file is padded out;
; the receiver truncates using the length in the header.
;
; Entry: PJSR @LOADADDR        Exit: PRTS
;==========================================================================

;--------------------------------------------------------------------------
; Transfer format
;--------------------------------------------------------------------------
DEVICE		equ	$7F		; universal SysEx device (broadcast)
SENDER		equ	$7F		; sender id in the file dump header
GROUPS		equ	16		; 7-byte groups per data packet
PKTLEN		equ	GROUPS*7	; = 112 file bytes per packet


;--------------------------------------------------------------------------
; Variable block, addressed through FP.
;
; Offsets 0..7 deliberately mirror the layout of a file table entry, so starting a file is a straight 8-byte copy -
; which also clears V_PKT, restarting packet numbering for each file.
;--------------------------------------------------------------------------
V_SRC		equ	0		; byte  source kind
V_HI		equ	1		; byte  read address A23-A16
V_LO		equ	2		; word  read address A15-A0
V_LHI		equ	4		; byte  bytes left, bits 23-16
V_PKT		equ	5		; byte  file dump packet number
V_LEN		equ	6		; word  bytes left, bits 15-0
V_PTR		equ	8		; word  cursor into the file table
V_CSUM		equ	10		; byte  running XOR checksum
VARLEN		equ	12

MAGIC		equ	$C0DA		; at LOADADDR+2; "coda" - the jump-here mark

		org	LOADADDR

;--------------------------------------------------------------------------
; entry: hand the machine to the transmit module, find ourselves,
;	 then walk the file table
;--------------------------------------------------------------------------
; The first four bytes are a signature, so a ROM hook can tell whether the payload has actually been loaded before it
; jumps in here. Both magic bytes are >= H'80, which a drum parameter written through the normal 41 xx xx path can
; never be - those are clamped to 0..127.
entry:		BRA	start				; The hook lands here,
		DC.W	MAGIC				;   and checks these two bytes first.
start:		STC.B	DP,@-SP				; The firmware's page registers go back
		STC.B	EP,@-SP				;   untouched.
		STM.W	(R0-FP),@-SP
		LDC.B	#0,DP				; Page 0 holds the table, the variables
		LDC.B	#0,EP				;   and the wave ROM port.
		BSR:16	txopen
		BSR	anchor				; Push the address of the next instruction and
anchor:		MOV:G.W	@SP+,FP				;   pop it back: this is how the code finds
		ADD:G.W	#vars-anchor,FP			;   itself.
		MOV:G.W	FP,R3
		ADD:G.W	#entry+TABLEOFS-vars,R3		; R3 = the file table

; the table may start with (register, value) pokes - anything model specific about the hardware belongs there, not here
setup:		MOV:G.W	@R3,R4				; A poke is (register, value).
		TST.W	R4
		BEQ	setupend			; A zero register ends the list.
		MOV:G.B	@(2,R3),R0
		MOV:G.B	R0,@R4
		ADD:Q.W	#2,R3				; ADD:Q takes 1 or 2 only, so four bytes
		ADD:Q.W	#2,R3				;   is two of them.
		BRA	setup
setupend:	ADD:Q.W	#2,R3				; Step over the terminator.
		MOV:F.W	R3,@(V_PTR,FP)
;--------------------------------------------------------------------------
; nextfile: copy one table entry into the variables and dump it
;--------------------------------------------------------------------------
nextfile:	MOV:F.W	@(V_PTR,FP),R3
		MOV:G.B	@R3,R0
		CMP:E.B	#SRC_END,R0
		BEQ	alldone				; H'FF ends the table.
		MOV:G.W	FP,R4
		MOV:I.W	#3,R5				; Four words: an entry is laid out like the
copy:		MOV:G.W	@R3,R0				;   variables, so a straight copy does it.
		MOV:G.W	R0,@R4
		ADD:Q.W	#2,R3
		ADD:Q.W	#2,R4
		SCB/F	R5,copy
		BSR	header
; one packet, then subtract PKTLEN from the 24-bit remaining count
pktloop:	BSR:16	packet
		MOV:F.W	@(V_LEN,FP),R0
		MOV:F.B	@(V_LHI,FP),R1
		SUB:G.W	#PKTLEN,R0			; The count is 24 bits: the low word here,
		BCC	noborrow			;   the high byte in R1.
		TST.B	R1
		BEQ	nextfile			; Borrowed past zero, so the file is done.
		ADD:Q.B	#-1,R1
		MOV:F.B	R1,@(V_LHI,FP)
noborrow:	MOV:F.W	R0,@(V_LEN,FP)
		TST.B	R1
		BNE	pktloop
		TST.W	R0
		BNE	pktloop				; Both halves zero, so the file is done.
		BRA	nextfile
;--------------------------------------------------------------------------
; alldone: put everything back and return to the ROM hook
;--------------------------------------------------------------------------
alldone:	LDM.W	@SP+,(R0-FP)
		LDC.B	@SP+,EP
		LDC.B	@SP+,DP
		BSR:16	txclose
		PRTS					; back to the ROM hook
;--------------------------------------------------------------------------
; header: send the file dump header. R3 points at the name in the table;
; on exit V_PTR points at the next entry. The header carries no checksum.
;--------------------------------------------------------------------------
header:		MOV:G.W	FP,R4
		ADD:G.W	#hdrtxt-vars,R4			; Found the same way as vars.
		MOV:I.W	#HDRLEN-1,R5
hdrlp:		MOV:G.B	@R4,R0
		ADD:Q.W	#1,R4
		BSR:16	tx
		SCB/F	R5,hdrlp
; length, 28 bits as four 7-bit bytes, least significant first
		MOV:F.B	@(V_LHI,FP),R2
		MOV:F.W	@(V_LEN,FP),R1
		MOV:I.W	#3,R5				; four bytes
lenlp:		MOV:G.W	R1,R0
		AND:G.B	#$7F,R0				; seven bits at a time
		BSR:16	tx
		MOV:I.W	#6,R4				; Shift the 24-bit count right seven places:
lensh:		SHLR.B	R2				;   the high byte into carry, and the carry
		ROTXR.W	R1				;   into the word.
		SCB/F	R4,lensh
		SCB/F	R5,lenlp
; file name: ASCII, NUL terminated in the table, ended by F7 on the wire
namelp:		MOV:G.B	@R3,R0
		ADD:Q.W	#1,R3
		TST.B	R0
		BEQ	namend				; The NUL is not sent.
		BSR:16	tx
		BRA	namelp
namend:		MOV:E.B	#$F7,R0
		BSR:16	tx				; The header carries no checksum.
; entries are word aligned, so round the cursor up past the NUL
		ADD:Q.W	#1,R3
		AND:G.W	#$FFFE,R3
		MOV:F.W	R3,@(V_PTR,FP)
		RTS
;--------------------------------------------------------------------------
; packet: send one file dump data packet, GROUPS*7 bytes of file data
;
; Each group is read twice - once to build the byte of stripped MSBs, once to send the data - which saves carrying a
; 7-byte buffer in registers.
;--------------------------------------------------------------------------
packet:		MOV:E.B	#$F0,R0
		BSR:16	tx				; F0 is outside the checksum.
		CLR.B	R0
		MOV:F.B	R0,@(V_CSUM,FP)			; The XOR starts here.
		MOV:E.B	#$7E,R0
		BSR:16	txs
		MOV:E.B	#DEVICE,R0
		BSR:16	txs
		MOV:E.B	#$07,R0				; file dump
		BSR:16	txs
		MOV:E.B	#$02,R0				; data packet
		BSR:16	txs
		MOV:F.B	@(V_PKT,FP),R0
		BSR:16	txs
		MOV:E.B	#GROUPS*8-1,R0			; The count goes out one less than it is.
		BSR:16	txs
		MOV:F.B	@(V_HI,FP),R2			; R2:R1 is the read address.
		MOV:F.W	@(V_LO,FP),R1
		MOV:I.W	#GROUPS-1,R5
grp:		MOV:G.W	R1,@-SP				; Keep the address: the group is read twice.
		MOV:G.W	R2,@-SP
		CLR.B	R3
		MOV:I.W	#6,R4				; seven bytes per group
pass1:		BSR	rdbyte
		SHLL.B	R3				; Collect the seven top bits.
		SHLL.B	R0
		BCC	pass1n
		ADD:Q.B	#1,R3
pass1n:		SCB/F	R4,pass1
		MOV:G.B	R3,R0
		BSR:16	txs				; The MSB byte goes first.
		MOV:G.W	@SP+,R2				; Rewind and read the group again.
		MOV:G.W	@SP+,R1
		MOV:I.W	#6,R4
pass2:		BSR	rdbyte
		AND:G.B	#$7F,R0				; MIDI data is seven bits.
		BSR:16	txs
		SCB/F	R4,pass2
		SCB/F	R5,grp
		MOV:F.B	@(V_CSUM,FP),R0
		BSR:16	tx				; The checksum and the F7 are outside it.
		MOV:E.B	#$F7,R0
		BSR:16	tx
		MOV:F.B	R2,@(V_HI,FP)			; Keep where the group loop got to.
		MOV:F.W	R1,@(V_LO,FP)
		MOV:F.B	@(V_PKT,FP),R0
		ADD:Q.B	#1,R0
		AND:G.B	#$7F,R0				; The packet number wraps at 128.
		MOV:F.B	R0,@(V_PKT,FP)
		RTS
;--------------------------------------------------------------------------
; rdbyte: R0 = the byte at R2:R1, then advance R2:R1
;--------------------------------------------------------------------------
rdbyte:		MOV:G.B	@FP,R0				; V_SRC
		CMP:E.B	#SRC_MCU,R0
		BEQ	rdmcu
		BSR:16	rdpcm				; The port is not at one address on every model.
		BRA	rdnext
rdmcu:		MOV:G.B	@R1,R0				; Page 0, so R2 is not used.
rdnext:		ADD:Q.W	#1,R1
		BNE	rdend
		ADD:Q.B	#1,R2				; Carry into A23-A16.
rdend:		RTS
CODEEND		equ	*	       ; everything past here is data

;--------------------------------------------------------------------------
; The constant part of every file dump header
;--------------------------------------------------------------------------
hdrtxt:		DC.B	$F0,$7E,DEVICE,$07,$01,SENDER
		DC.B	'BIN '				; the file type, four characters
HDRLEN		equ	*-hdrtxt

;--------------------------------------------------------------------------
; Working storage. Nothing here needs initialising by the loader.
;--------------------------------------------------------------------------
		align	2
vars:		DC.B	0,0,0,0,0,0,0,0,0,0,0,0		; VARLEN bytes
BODYEND		equ	*		; the transmit module follows, at TXOFS
;--------------------------------------------------------------------------
; The file table is a separate binary, loaded at LOADADDR+TABLEOFS. This ORG is here so that assembling the body fails
; loudly if it ever grows past the start of the table.
;--------------------------------------------------------------------------
