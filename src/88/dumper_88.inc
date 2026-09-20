;==========================================================================
; sc-mcu-wave-romdumper - RAM resident dumper, the part the SC-88 family shares
;
; The dumper leaves the wave ROM in the user areas of RAM and the host reads those back with ordinary bulk dump requests.
; One call fills the buffer once. The host asks for the next part by writing a new request and calling again.
;
; The buffer is User Tone Bank and User Drum Set, where one RAM byte becomes one SysEx byte. The firmware masks it
; to seven bits on the way out, so this packs the data itself: seven bytes become eight, the first of which carries
; their seven top bits.
;
; The User Tone Banks AND User Drum Sets are lost. They are battery backed, and nothing here puts them back.
;
; The request, four words at LOADADDR+ARGOFS:
;
;   +0  the value for the bank register: chip select and address bit 20
;   +2  the value for the page register: address bits 19-10
;   +4  the byte offset in the window, even, address bits 9-0
;   +6  how many seven-byte groups to fill, 1 to GROUPS
;
; A pass reads GROUPS*7 bytes. The bank register is written once per pass, so a pass must not cross a bank; the host
; keeps to that.
;
; A word comes back with its two bytes the other way round, so the low half is the earlier ROM byte.
;
; What the dumper file has to define:
;
;   LOADADDR  where the host loads this
;   RAMPAGE   the page LOADADDR and BUF are in
;   XPPAGE    the page the tone generator answers on
;   BUF       the buffer: BUFSIZE bytes in one unbroken run
;   BUFSIZE
;
; Entry: PJSR @LOADADDR        Exit: PRTS
;==========================================================================

		ifndef	LOADADDR
		 fatal	"the dumper has to define LOADADDR"
		endif
		ifndef	RAMPAGE
		 fatal	"the dumper has to define RAMPAGE"
		endif
		ifndef	XPPAGE
		 fatal	"the dumper has to define XPPAGE - it is not the same page on every model"
		endif
		ifndef	BUF
		 fatal	"the dumper has to define BUF and BUFSIZE"
		endif

MAGIC		equ	$C0DA		; at LOADADDR+2; the hook checks for it

;--------------------------------------------------------------------------
; Tone generator registers, as offsets into XPPAGE. The same on every model in the family.
;--------------------------------------------------------------------------
XPDATA		equ	$3910		; what the last read returned
XPSTATUS	equ	$391C		; bit 7 is busy
XPBANKLO	equ	$3920		; address bits 19-10
XPBANKHI	equ	$3922		; chip select and address bit 20
XPWINDOW	equ	$3C00		; 1 KB window, address bits 9-0
WINSIZE		equ	$0400

; The host leaves the request in Drum Map Name, the drum map's last field, as the SC-55 dumper does.
ARGOFS		equ	$380
ARGLEN		equ	12
REQ		equ	LOADADDR+ARGOFS	; the request, four words

		if	8>ARGLEN
		 fatal	"the request does not fit in Drum Map Name"
		endif

;--------------------------------------------------------------------------
; The header at the start of the buffer. The host writes the first half and
; this writes the second. Every byte is seven bits, because the firmware
; masks this area on the way out.
;--------------------------------------------------------------------------
HDRSIZE		equ	16
HDR_BANK	equ	8		; byte   what went to the bank register
HDR_PAGE	equ	9		; 2 x 7  what went to the page register
HDR_GROUPS	equ	11		; 2 x 7  groups filled
HDR_GIVEUP	equ	13		; 2 x 7  reads that gave up waiting
HDR_SPARE	equ	15

GROUPS		equ	(BUFSIZE-HDRSIZE)/8	; groups of eight bytes out
BUSYWAIT	equ	$1000		; give up rather than hang the machine

		org	LOADADDR

;--------------------------------------------------------------------------
; The hook lands on entry and reads the two bytes behind it first, so a
; machine that was never loaded is never jumped into.
;--------------------------------------------------------------------------
entry:		BRA	start
		DC.W	MAGIC

start:		STC.B	DP,@-SP
		STC.B	EP,@-SP
		STM.W	(R0-FP),@-SP
		LDC.B	#RAMPAGE,DP
		LDC.B	#RAMPAGE,EP

; R0-R3 read through DP, R4-FP through EP. So DP holds the XP page for the
; pass and EP holds the RAM page for the store, and neither has to move.
		MOV:G.W	@REQ:16,R3		; for XPBANKHI
		MOV:G.W	@REQ+2:16,R2		; for XPBANKLO
		MOV:G.W	@REQ+4:16,R1		; byte offset in the window
		MOV:G.W	@REQ+6:16,R5		; groups wanted
		MOV:I.W	#BUF,R4

; A request that asks for more than fits would write past the last region.
		CMP:I.W	#GROUPS,R5
		BLS	sized
		MOV:I.W	#GROUPS,R5
sized:		TST.W	R5
		BEQ	done

;--------------------------------------------------------------------------
; The second half of the header: what this call actually did. The host wrote
; the first half before it asked, and it comes back untouched, so the two
; halves together say whether the machine read what it was asked for.
;--------------------------------------------------------------------------
		MOV:G.B	R3,@(HDR_BANK,R4)
		MOV:G.W	R2,R0			; the page register, in two sevens
		BSR	hdrhigh
		MOV:G.B	R0,@(HDR_PAGE,R4)
		MOV:G.W	R2,R0
		AND:G.B	#$7F,R0
		MOV:G.B	R0,@(HDR_PAGE+1,R4)
		MOV:G.W	R5,R0			; the groups it is about to fill
		BSR	hdrhigh
		MOV:G.B	R0,@(HDR_GROUPS,R4)
		MOV:G.W	R5,R0
		AND:G.B	#$7F,R0
		MOV:G.B	R0,@(HDR_GROUPS+1,R4)
		CLR.B	R0
		MOV:G.B	R0,@(HDR_GIVEUP,R4)	; not counted yet; the format keeps the room
		MOV:G.B	R0,@(HDR_GIVEUP+1,R4)
		MOV:G.B	R0,@(HDR_SPARE,R4)
		ADD:G.W	#HDRSIZE,R4		; the data starts after the header

		ADD:Q.W	#-1,R5			; SCB/F runs one more time than it counts
		LDC.B	#XPPAGE,DP		; @aa:16 is the XP chip from here
		MOV:G.W	R3,@XPBANKHI:16		; the bank holds for the whole pass
		BSR	setpage

;--------------------------------------------------------------------------
; Eight bytes out for every seven in. The group is read twice - once to
; collect the seven top bits, once for the data, and saves carrying a
; seven-byte buffer in registers.
;--------------------------------------------------------------------------
group:		MOV:G.W	R1,@-SP			; Keep the position: the group is read twice.
		MOV:G.W	R2,@-SP
		CLR.B	R3
		MOV:I.W	#6,FP
pass1:		BSR	rdbyte
		SHLL.B	R3			; Collect the seven top bits.
		SHLL.B	R0
		BCC	pass1n
		ADD:Q.B	#1,R3
pass1n:		SCB/F	FP,pass1
		MOV:G.B	R3,@R4+			; The byte of top bits goes first.
		MOV:G.W	@SP+,R2			; Rewind and read the group again.
		MOV:G.W	@SP+,R1
		BSR	setpage
		MOV:I.W	#6,FP
pass2:		BSR	rdbyte
		AND:G.B	#$7F,R0			; The firmware would mask it anyway.
		MOV:G.B	R0,@R4+
		SCB/F	FP,pass2
		SCB/F	R5,group

done:		LDC.B	#RAMPAGE,DP
		LDM.W	@SP+,(R0-FP)
		LDC.B	@SP+,EP
		LDC.B	@SP+,DP
		PRTS

;--------------------------------------------------------------------------
; setpage: tell the chip which 1 KB of the bank the window shows
;--------------------------------------------------------------------------
setpage:	MOV:G.W	R2,@XPBANKLO:16
		RTS

;--------------------------------------------------------------------------
; hdrhigh: R0 = bits 13-7 of R0, for the seven-bit halves of a header field
;--------------------------------------------------------------------------
hdrhigh:	SHLL.W	R0
		SWAP.B	R0
		AND:G.B	#$7F,R0
		RTS

;--------------------------------------------------------------------------
; rdbyte: R0 = the byte at R2:R1, then step R1 and roll into the next page
;
; A word is fetched for each of the two bytes in it. That is one wasted read
; per byte, and a read is far shorter than the MIDI byte it ends up in.
;--------------------------------------------------------------------------
rdbyte:		MOV:G.W	FP,@-SP			; The wait needs a register of its own.
		STC.W	SR,@-SP
		ORC.W	#$0700,SR		; The firmware reads 3910 for its own
		MOV:G.W	R1,R0			;   voices, so nothing may come between
		AND:G.B	#$FE,R0			;   the window read and the data read.
; The index has to be R0-R3. Those read through DP, and R4-FP read through EP,
; so an index in FP would have gone looking for the window in RAM.
		MOV:G.W	@(XPWINDOW,R0),R0	; The dummy read picks the word.
		MOV:I.W	#BUSYWAIT,FP
busy:		BTST:G.W #7,@XPSTATUS:16
		BEQ	ready
		ADD:Q.W	#-1,FP
		BNE	busy
ready:		MOV:G.W	@XPDATA:16,R0
		LDC.W	@SP+,SR
		MOV:G.W	@SP+,FP
; The low half is the earlier ROM byte, so an odd offset wants the high half.
		BTST.W	#0,R1
		BEQ	rdstep
		SWAP.B	R0
rdstep:		ADD:Q.W	#1,R1
		CMP:I.W	#WINSIZE,R1
		BCS	rdend
		CLR.W	R1			; Past the window: the next 1 KB of the bank.
		ADD:Q.W	#1,R2
		MOV:G.W	R2,@XPBANKLO:16
rdend:		RTS
