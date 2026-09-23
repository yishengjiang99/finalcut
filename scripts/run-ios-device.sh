#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project_file="$project_root/ios/FinalCut.xcodeproj"
derived_data="$project_root/ios/build-device"
device_id="${IOS_DEVICE_ID:-}"

if [[ -z "$device_id" ]]; then
  device_id="$(xcrun devicectl list devices | awk '$NF == "physical" { print $3; exit }' | sed 's/[[:space:]]*(UDID)$//')"
fi

if [[ -z "$device_id" ]]; then
  echo "No connected physical iOS device was found." >&2
  echo "Connect and trust an iPhone/iPad, or set IOS_DEVICE_ID to its UDID." >&2
  exit 1
fi

xcodebuild \
  -project "$project_file" \
  -scheme FinalCut \
  -destination "platform=iOS,id=$device_id" \
  -derivedDataPath "$derived_data" \
  build

app_path="$derived_data/Build/Products/Debug-iphoneos/FinalCut.app"
xcrun devicectl device install app --device "$device_id" "$app_path"
xcrun devicectl device process launch --device "$device_id" com.ragnus.w2

echo "FinalCut is running on iOS device $device_id."
