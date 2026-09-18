# sc-mcu-wave-romdumper
#
#   src/55/*.asm  --asl-->  build/*.p  --p2bin-->  build/*.bin  --mksyx-->  syx/*
#
# src/55 holds the dumpers for the synths that put the dump on MIDI Out
# themselves, as a MIDI File Dump. That is a way of working, not a model
# number: the RA-30, XP-10 and PMA-5 are in there too.
#
# src/55/dumper_*.asm are the dumpers (body plus one transmit module each).
# src/55/[mcu-]wave-*.asm and src/55/probe.asm are the file tables. The name
# says what a table dumps, so the mcu- ones start with the MCU internal ROM.
#
# Needs The Macro Assembler AS (asl and p2bin) and Node.
# There is no Python and there are no npm packages.
#
#   make            build syx/ from src/
#   make check      re-run the build and fail if syx/ is out of date
#   make check-tools  report which tools were found
#   make clean      remove build/
#   make distclean  also remove the generated syx/

ASL       ?= asl
P2BIN     ?= p2bin
NODE      ?= node

CPU        = HD6475328
ASFLAGS    = -cpu $(CPU) -i src/55 -q
# p2bin defaults to the range 0-$7fff and the dumper lives at H'8CD4, so
# without -r the output would be empty.  '$-$' means "whatever was used".
P2BINFLAGS = -r '$$-$$' -l 0

SRC   := $(wildcard src/55/dumper_*.asm) $(wildcard src/55/*wave-*.asm) src/55/probe.asm
INC   := $(wildcard src/55/*.inc)
BIN   := $(patsubst src/55/%.asm,build/%.bin,$(SRC))
STAMP := syx/models.json

.PHONY: all check check-tools clean distclean
.PRECIOUS: build/%.p

all: $(STAMP)

build:
	@mkdir -p build

build/%.p: src/55/%.asm $(INC) | build
	$(ASL) $(ASFLAGS) -o $@ $<

build/%.bin: build/%.p
	$(P2BIN) $< $@ $(P2BINFLAGS)

$(STAMP): $(BIN) tools/mksyx.js tools/bulk_load.js tools/file_table.js tools/smf_write.js \
          src/55/dumper.inc tools/catalogue.json lib/format.js lib/sysex.js
	$(NODE) tools/mksyx.js

# Rebuild into a scratch directory and compare, so a stale syx/ is caught.
check: $(BIN)
	@rm -rf build/_check && mkdir -p build/_check
	@$(NODE) tools/mksyx.js --out build/_check >/dev/null
	@if diff -r -q syx build/_check >/dev/null 2>&1; then \
		echo "syx/ is up to date"; \
	else \
		echo "syx/ is stale - run make"; diff -r -q syx build/_check; exit 1; \
	fi

check-tools:
	@printf '%-8s ' asl;   $(ASL) -h 2>&1 | head -1 || echo 'NOT FOUND'
	@printf '%-8s ' p2bin; $(P2BIN) 2>&1 | head -1 || echo 'NOT FOUND'
	@printf '%-8s ' node;  $(NODE) --version 2>/dev/null || echo 'NOT FOUND'

clean:
	rm -rf build

distclean: clean
	rm -f syx/*.syx syx/*.mid $(STAMP)
