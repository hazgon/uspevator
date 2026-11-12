#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
base="$PWD/android_uspevator"
sdk_root="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
if [[ -n "$sdk_root" ]]; then
  sdk="$sdk_root/build-tools/35.0.0"
  platform="$sdk_root/platforms/android-35/android.jar"
else
  sdk="$base/sdk/android-15"
  platform="$base/sdk/android-35/android.jar"
fi
work="$base/out"
signing="$base/signing"
mkdir -p "$work"/{gen,classes,dex} "$base/app/assets"
python3 build_uspevator/build.py
node "$base/prepare-assets.cjs"
"$sdk/aapt2" compile --dir "$base/app/res" -o "$work/res.zip"
"$sdk/aapt2" link -I "$platform" --manifest "$base/app/AndroidManifest.xml" --java "$work/gen" \
  -A "$base/app/assets" -o "$work/resources.apk" "$work/res.zip"
mapfile -t java_sources < <(find "$base/app/src" "$work/gen" -name '*.java' -type f)
java -jar "$base/tooling/ecj.jar" -1.8 -nowarn -proc:none -encoding UTF-8 \
  -classpath "$platform" -d "$work/classes" "${java_sources[@]}"
python3 - "$work" <<'PY'
from pathlib import Path
import sys, zipfile
root = Path(sys.argv[1])
with zipfile.ZipFile(root/'classes.jar','w',zipfile.ZIP_DEFLATED) as z:
 for path in sorted((root/'classes').rglob('*.class')):
  z.write(path,path.relative_to(root/'classes'))
PY
"$sdk/d8" --min-api 26 --lib "$platform" --output "$work/dex" "$work/classes.jar"
python3 - "$work" <<'PY'
from pathlib import Path
import shutil, sys, zipfile
root=Path(sys.argv[1])
shutil.copyfile(root/'resources.apk',root/'unsigned.apk')
with zipfile.ZipFile(root/'unsigned.apk','a',zipfile.ZIP_DEFLATED) as z:
 for path in sorted((root/'dex').glob('*.dex')):
  z.write(path,path.name)
PY
"$sdk/zipalign" -f 4 "$work/unsigned.apk" "$work/aligned.apk"
if [[ ! -s "$signing/release.p12" ]]; then
  printf 'APK без подписи: %s\n' "$work/aligned.apk"
  exit 0
fi
"$sdk/apksigner" sign --ks "$signing/release.p12" --ks-pass "file:$signing/pass" --ks-key-alias uspevator \
  --v4-signing-enabled false --out "$PWD/uspevator.apk" "$work/aligned.apk"
"$sdk/apksigner" verify --verbose "$PWD/uspevator.apk"
"$sdk/aapt2" dump badging "$PWD/uspevator.apk" | awk '/^package:|^sdkVersion:|^targetSdkVersion:|^application-label:/{print}'
