#!/usr/bin/env bash
# Compile the shaders in app.js with a real GLSL ES 3.0 compiler.
#
# `node --check` only parses JavaScript, so a shader typo ships silently and the
# headset reports a bare compile error with no stack. This catches it on the
# host. Requires glslangValidator (package: glslang-tools).
set -euo pipefail

HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
APP="$HERE/public/app.js"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

extract() {
  # Print the template literal that follows the given const declaration. Read to
  # the closing backtick rather than inferring it from line content, so a shader
  # containing a stray backtick cannot truncate the output silently.
  python3 - "$APP" "$1" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
name = sys.argv[2]
m = re.search(r'const %s = `(.*?)`;' % re.escape(name), src, re.S)
if not m:
    sys.exit(f'could not find the {name} template literal')
sys.stdout.write(m.group(1))
PY
}

extract VERT > "$OUT/vert.glsl"
extract FRAG > "$OUT/frag.glsl"

fail=0
for stage in vert frag; do
  if out=$(glslangValidator -S "$stage" "$OUT/$stage.glsl" 2>&1); then
    echo "  $stage: ok"
  else
    echo "  $stage: FAILED"
    echo "$out" | sed 's/^/    /'
    fail=1
  fi
done

# The fragment stage must composite premultiplied alpha, because the XR layer
# does. A regression here is invisible until the panel looks washed out.
if grep -q 'texture(uTex, vUV)' "$OUT/frag.glsl"; then
  echo "  panel fetch: present"
else
  echo "  frag does not sample the panel texture"; fail=1
fi
if grep -q 'texture(uCursor, vUV)' "$OUT/frag.glsl"; then
  echo "  cursor fetch: present"
else
  echo "  frag does not sample the cursor texture"; fail=1
fi
if grep -q 'c.rgb \* c.a' "$OUT/frag.glsl"; then
  echo "  premultiply: present"
else
  echo "  frag does not premultiply alpha (XR layer requires it)"; fail=1
fi

[[ $fail -eq 0 ]] && echo "shaders: ok" || { echo "shaders: FAILED"; exit 1; }