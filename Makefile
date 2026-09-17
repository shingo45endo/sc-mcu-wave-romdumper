# sc-mcu-wave-romdumper
#
#   src/*.asm  --asl-->  build/*.p  --p2bin-->  build/*.bin  --mksyx-->  syx/*
#
# src/dumper_*.asm are the payloads (body plus one transmit module each).
# src/[mcu-]wave-*.asm and src/probe.asm are the file tables. The name says
# what a table dumps, so the mcu- ones start with the MCU internal ROM.
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
ASFLAGS    = -cpu $(CPU) -i src -q
# p2bin defaults to the range 0-$7fff and the payload lives at H'8CD4, so
# without -r the output would be empty.  '$-$' means "whatever was used".
P2BINFLAGS = -r '$$-$$' -l 0

SRC   := $(wildcard src/dumper_*.asm) $(wildcard src/*wave-*.asm) src/probe.asm
INC   := $(wildcard src/*.inc)
BIN   := $(patsubst src/%.asm,build/%.bin,$(SRC))
STAMP := syx/models.json

.PHONY: all check check-tools clean distclean
.PRECIOUS: build/%.p

all: $(STAMP)

build:
	@mkdir -p build

build/%.p: src/%.asm $(INC) | build
	$(ASL) $(ASFLAGS) -o $@ $<

build/%.bin: build/%.p
	$(P2BIN) $< $@ $(P2BINFLAGS)

$(STAMP): $(BIN) tools/mksyx.js tools/bulk_load.js tools/file_table.js tools/smf_write.js \
          src/dumper.inc src/catalogue.json lib/format.js lib/sysex.js
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
