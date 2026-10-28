#!/usr/bin/env bash
# xcodebuild build / test for the iOS app on a Simulator.
#   npm run ios:build
#   npm run ios:test
#   npm run ios:test -- -only-testing:FinalCutTests/ProjectComposerTests
# Extra arguments are passed straight to xcodebuild. IOS_SIMULATOR_NAME picks a device.

set -euo pipefail

action="${1:-}"
if [[ "$action" != "build" && "$action" != "test" ]]; then
  echo "usage: $0 build|test [xcodebuild args...]" >&2
  exit 2
fi
shift

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project_file="$project_root/ios/FinalCut.xcodeproj"
derived_data="$project_root/ios/build"
simulator_name="${IOS_SIMULATOR_NAME:-}"

if ! xcrun simctl list runtimes | grep -q "iOS"; then
  echo "No iOS Simulator runtime is installed. Install one with:" >&2
  echo "  xcodebuild -downloadPlatform iOS" >&2
  exit 1
fi

if [[ -n "$simulator_name" ]]; then
  device_line="$(xcrun simctl list devices available | grep -F "    $simulator_name (" | head -n 1 || true)"
else
  # Prefer a booted iPhone, then any available one.
  device_line="$(xcrun simctl list devices available | grep -E "^    .*iPhone.*\([0-9A-F-]{36}\) \(Booted\)" | head -n 1 || true)"
  if [[ -z "$device_line" ]]; then
    device_line="$(xcrun simctl list devices available | grep -E "^    .*iPhone.*\([0-9A-F-]{36}\)" | head -n 1 || true)"
  fi
fi

if [[ -z "$device_line" ]]; then
  if [[ -n "$simulator_name" ]]; then
    echo "Simulator '$simulator_name' is not available." >&2
    exit 1
  fi
  device_type="$(xcrun simctl list devicetypes | sed -nE 's/^(iPhone [^(]*Pro) \((com\.apple[^)]*)\)$/\2/p' | tail -n 1)"
  runtime="$(xcrun simctl list runtimes | sed -nE 's/^iOS .* - (com\.apple\.CoreSimulator\.SimRuntime\.iOS[^ ]*)$/\1/p' | tail -n 1)"
  echo "No iPhone Simulator found; creating 'FinalCut Test iPhone' ($device_type)."
  device_id="$(xcrun simctl create "FinalCut Test iPhone" "$device_type" "$runtime")"
  device_state="Shutdown"
else
  device_id="$(printf '%s\n' "$device_line" | sed -nE 's/.*\(([0-9A-F-]{36})\).*/\1/p')"
  device_state="$(printf '%s\n' "$device_line" | sed -nE 's/.*\(([0-9A-F-]{36})\) \(([^)]*)\).*/\2/p')"
fi

if [[ "$device_state" != "Booted" ]]; then
  xcrun simctl boot "$device_id"
fi
xcrun simctl bootstatus "$device_id" -b >/dev/null

xcodebuild \
  -project "$project_file" \
  -scheme FinalCut \
  -destination "platform=iOS Simulator,id=$device_id" \
  -derivedDataPath "$derived_data" \
  "$action" "$@"
