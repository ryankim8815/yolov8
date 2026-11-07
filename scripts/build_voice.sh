#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."
out=.cache/voice
mkdir -p "$out"
stage=$(mktemp -d "$out/build.XXXXXX")
trap 'rm -rf "$stage"' EXIT
xcrun --sdk macosx swiftc -swift-version 5 -parse-as-library -O -target arm64-apple-macos27.0 \
  -module-cache-path "$out/modules" native/voice/*.swift \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker native/voice/Info.plist \
  -o "$stage/packing-voice"
codesign --force --sign - --identifier local.visionlab.packing-voice "$stage/packing-voice"
mv -f "$stage/packing-voice" "$out/packing-voice"
echo "Built $out/packing-voice"
