#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project_file="$project_root/ios/FinalCut.xcodeproj"
derived_data="$project_root/ios/build"
simulator_name="${IOS_SIMULATOR_NAME:-}"

if [[ -z "$simulator_name" ]]; then
  simulator_name="$(xcrun simctl list devices available | sed -nE 's/^    (iPhone[^()]*) \([0-9A-F-]{36}\).*/\1/p' | head -n 1 | sed 's/[[:space:]]*$//')"
fi

if [[ -z "$simulator_name" ]]; then
  echo "No available iPhone Simulator was found." >&2
  exit 1
fi

device_line="$(xcrun simctl list devices available | grep -F "    $simulator_name (" | head -n 1 || true)"
device_id="$(printf '%s\n' "$device_line" | sed -nE 's/.*\(([0-9A-F-]{36})\).*/\1/p')"
device_state="$(printf '%s\n' "$device_line" | sed -nE 's/.*\(([0-9A-F-]{36})\) \(([^)]*)\).*/\2/p')"

if [[ -z "$device_id" ]]; then
  echo "Simulator '$simulator_name' is not available." >&2
  echo "Set IOS_SIMULATOR_NAME to an available iPhone model." >&2
  exit 1
fi

if [[ "$device_state" != "Booted" ]]; then
  xcrun simctl boot "$device_id"
fi

xcrun simctl bootstatus "$device_id" -b

xcodebuild \
  -project "$project_file" \
  -scheme FinalCut \
  -destination "platform=iOS Simulator,id=$device_id" \
  -derivedDataPath "$derived_data" \
  build

xcrun simctl install "$device_id" "$derived_data/Build/Products/Debug-iphonesimulator/FinalCut.app"
xcrun simctl launch "$device_id" com.ragnus.w2

echo "FinalCut is running on $simulator_name."
