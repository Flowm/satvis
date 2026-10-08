#!/bin/sh
# Xcode Cloud runs this after cloning. PostHog's project key and host come from
# the workflow's environment, POSTHOG_PROJECT_TOKEN as a secret and POSTHOG_HOST,
# and go where Config/Base.xcconfig includes them. Without them the build counts
# nothing.
set -eu
cd "$(dirname "$0")/.."
if [ -n "${POSTHOG_PROJECT_TOKEN:-}" ]; then
    # "//" starts a comment in an xcconfig.
    host=$(printf '%s' "${POSTHOG_HOST:-https://eu.i.posthog.com}" | sed 's|//|/$()/|')
    printf 'POSTHOG_PROJECT_TOKEN = %s\nPOSTHOG_HOST = %s\n' "$POSTHOG_PROJECT_TOKEN" "$host" > Config/Analytics.xcconfig
fi
