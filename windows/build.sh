#!/bin/bash
# Builds dist/Slovo.exe: downloads whisper.cpp and ffmpeg for Windows, packs them with the Silero VAD model into
# payload/bin.zip and compiles the Go program with the icon. Runs on a Mac and on Windows (Git Bash, GitHub Actions);
# only on Windows does it add the Visual C++ runtime that whisper.cpp needs and not every computer has.
#   ./windows/build.sh
#   VERSION=1.3.0 ./windows/build.sh
set -euo pipefail
cd "$(dirname "$0")"

VERSION="${VERSION:-$(sed -n 's/^VERSION="\${VERSION:-\(.*\)}"$/\1/p' ../scripts/build_app.sh)}"
WHISPER_BUILD=b5454 # whisper.cpp release with Windows binaries
FFMPEG_ZIP=ffmpeg-n8.1-latest-win64-lgpl-8.1.zip # BtbN's static LGPL build, updated daily
CACHE=build/downloads

mkdir -p "$CACHE" dist
fetch() {
    [ -s "$CACHE/$2" ] && return
    curl -fsSL --retry 3 -o "$CACHE/$2.tmp" "$1"
    mv "$CACHE/$2.tmp" "$CACHE/$2"
}
fetch "https://github.com/ggml-org/whisper.cpp/releases/download/$WHISPER_BUILD/whisper-bin-x64.zip" "whisper-$WHISPER_BUILD-x64.zip"
fetch "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/$FFMPEG_ZIP" "$FFMPEG_ZIP"

runtime=()
if [ -n "${SYSTEMROOT:-}" ]; then
    for dll in msvcp140.dll vcruntime140.dll vcruntime140_1.dll vcomp140.dll; do
        runtime+=("$(cygpath -u "$SYSTEMROOT")/System32/$dll")
    done
else
    echo "warning: no Visual C++ runtime outside Windows, this Slovo.exe needs it installed" >&2
fi

echo "Packing tools (Slovo $VERSION)"
whisper="$CACHE/whisper-$WHISPER_BUILD-x64.zip"
go run ./tools/pack payload/bin.zip \
    "$whisper!whisper-cli.exe" "$whisper!whisper.dll" "$whisper!ggml.dll" "$whisper!ggml-base.dll" "$whisper!ggml-cpu-*.dll" \
    "$CACHE/$FFMPEG_ZIP!ffmpeg.exe" "$CACHE/$FFMPEG_ZIP!LICENSE.txt" ../Resources/ggml-silero-v6.2.0.bin \
    ../Resources/LICENSE-silero-vad.txt ../Sources/CWhisper/include/LICENSE-whisper.cpp.txt \
    ${runtime[@]+"${runtime[@]}"}

# Icon, version and manifest of the exe
go run github.com/tc-hib/go-winres@v0.3.3 simply --arch amd64 --icon ../Resources/AppIcon-1024.png --manifest gui \
    --product-name Slovo --file-description Slovo --product-version "$VERSION" --file-version "$VERSION"

GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -H windowsgui -X main.version=$VERSION" \
    -o dist/Slovo.exe .
ls -l dist/Slovo.exe
