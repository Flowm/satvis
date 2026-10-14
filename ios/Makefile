# Tasks for the iOS app; see AGENTS.md. `make help` lists them from the `##`
# notes: a task's note follows its name, then `| ` and the variables it takes;
# a variable's note is a line of its own.

## DEVICE    The simulator, by name (default iPhone 18 Pro)
## RUNTIME   Its runtime, e.g. "iOS 27" (default the newest that has DEVICE)
## UDID      One simulator exactly, in place of DEVICE and RUNTIME
## API       The worker run talks to (default https://satvis.space)
## SHOTS     The screenshots to retake alone, e.g. 2Sky
## BASE_URL  The site screenshots opens its views on (default https://satvis.space)
## DRY_RUN   The uploads say what they would change, and change nothing
## VERSION   The App Store version the downloads fetch (default the one being prepared)
## ASC_*     asc's own settings for the uploads and downloads, e.g. ASC_PROFILE, ASC_READ_ONLY=1

DEVICE ?= iPhone 18 Pro
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

.DEFAULT_GOAL := help

.PHONY: build test test-kit run logs format lint screenshots screenshots-upload screenshots-download metadata-download metadata-upload clean help

build: ## Build the app for the simulator | DEVICE RUNTIME UDID
	$(XCODEBUILD) build

test: test-kit ## Run the package tests, then the UI tests | DEVICE RUNTIME UDID
	$(XCODEBUILD) test

test-kit: ## Run the package tests on macOS
	swift test --package-path SatvisKit

run: export SIMCTL_CHILD_SATVIS_API = $(API)
run: build ## Build and launch the app on the simulator | DEVICE RUNTIME UDID API
	xcrun simctl boot $(UDID) 2>/dev/null || true
	xcrun simctl install $(UDID) $(APP)
	xcrun simctl launch --terminate-running-process $(UDID) org.frcy.app.satvis

logs: ## Stream the app's log from the simulator | DEVICE RUNTIME UDID
	xcrun simctl spawn $(UDID) log stream --level debug --style compact --predicate 'subsystem == "org.frcy.app.satvis"'

format: ## Format the Swift sources
	swift format -i -r $(SOURCES)

lint: ## Check the Swift sources' format, as CI does
	swift format lint -r -s $(SOURCES)

screenshots: ## Take the App Store screenshots | SHOTS BASE_URL
	scripts/screenshots.sh $(SHOTS)

screenshots-upload: ## Replace the prepared version's screenshots | DRY_RUN
	scripts/screenshots-upload.sh

screenshots-download: ## Download a version's screenshots | VERSION
	scripts/screenshots-download.sh

metadata-download: ## Download the listing's text to metadata/ | VERSION
	scripts/metadata-download.sh

metadata-upload: ## Update the listing's text from metadata/ | DRY_RUN
	scripts/metadata-upload.sh

clean: ## Delete the build and the screenshots
	rm -rf build screenshots SatvisKit/.build

help: ## List the tasks and the variables they take
	@echo "Usage: make <task> [VARIABLE=value ...]"
	@echo
	@echo Tasks:
	@awk -F ':.*## | \\| ' '/^[a-z-]+:.*## / { line = sprintf("  %-21s %-44s %s", $$1, $$2, $$3); sub(/ +$$/, "", line); print line }' $(MAKEFILE_LIST)
	@echo
	@echo Variables:
	@awk '/^## / { name = $$2; $$1 = $$2 = ""; sub(/^ +/, ""); printf "  %-21s %s\n", name, $$0 }' $(MAKEFILE_LIST)
