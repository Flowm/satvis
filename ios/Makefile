# Tasks for the iOS app; see AGENTS.md.
# DEVICE picks the simulator by name, on RUNTIME (e.g. "iOS 27") or the newest
# runtime that has it. API replaces satvis.space for `make run`.

DEVICE ?= iPhone 17
RUNTIME ?=
API ?=
# Not ?=, so that an ASC_APP_ID in the environment cannot point the listing
# tasks at another app.
export ASC_APP_ID = 1441084766

UDID = $(or $(shell scripts/simulator-udid.sh "$(DEVICE)" "$(RUNTIME)"),$(error No available simulator named "$(DEVICE)" $(RUNTIME)))
DERIVED_DATA = build/DerivedData
APP = $(DERIVED_DATA)/Build/Products/Debug-iphonesimulator/satvis.app
XCODEBUILD = xcodebuild -project satvis.xcodeproj -scheme satvis -derivedDataPath $(DERIVED_DATA) -destination id=$(UDID) CODE_SIGNING_ALLOWED=NO
SOURCES = satvis satvisUITests SatvisKit

.PHONY: build test test-kit run logs format lint screenshots screenshots-upload screenshots-download clean

build:
	$(XCODEBUILD) build

test: test-kit
	$(XCODEBUILD) test

test-kit:
	swift test --package-path SatvisKit

run: export SIMCTL_CHILD_SATVIS_API = $(API)
run: build
	xcrun simctl boot $(UDID) 2>/dev/null || true
	xcrun simctl install $(UDID) $(APP)
	xcrun simctl launch --terminate-running-process $(UDID) org.frcy.app.satvis

logs:
	xcrun simctl spawn $(UDID) log stream --level debug --style compact --predicate 'subsystem == "org.frcy.app.satvis"'

format:
	swift format -i -r $(SOURCES)

lint:
	swift format lint -r -s $(SOURCES)

screenshots:
	scripts/screenshots.sh $(SHOTS)

screenshots-upload:
	scripts/screenshots-upload.sh

screenshots-download:
	scripts/screenshots-download.sh

clean:
	rm -rf build screenshots SatvisKit/.build
