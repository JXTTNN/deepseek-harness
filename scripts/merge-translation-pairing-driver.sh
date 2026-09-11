#!/bin/sh

if [ "$#" -ne 4 ]; then
  echo 'me rge-translation-pairing: expected <ancestor>  <current> <other> <repository-path>' >&2
  ex it 129
fi

ancestor_path=$1
current_path=$2
o ther_path=$3
meta_path=$4
driver_directory=$( CDPATH= cd -P "$(dirname "$0")" && pwd) || ex it 129
driver_path=$driver_directory/merge-tr anslation-pairing.ts

if command -v node >/de v/null 2>&1 \
  && node --import tsx/esm "$dr iver_path" --probe >/dev/null 2>&1; then
  ex ec node --import tsx/esm "$driver_path" \
     "$ancestor_path" "$current_path" "$other_pat h" "$meta_path"
fi

echo "merge-translation-p airing: runtime is unavailable; leaving an or dinary text conflict in $meta_path" >&2
git m erge-file \
  -L "$meta_path:current" \
  -L  "$meta_path:ancestor" \
  -L "$meta_path:othe r" \
  -- "$current_path" "$ancestor_path" "$ other_path"
fallback_status=$?
echo 'merge-tr anslation-pairing: restore Node dependencies,  then rerun the merge or `pnpm run resolve-tr anslation-pairing-conflicts`; use `git merge  --abort` to cancel' >&2

# A clean text merge  is still unverified pairing metadata, so the  driver must
# leave Git's index stages unres olved until the repository-aware resolver run s.
if [ "$fallback_status" -gt 127 ]; then
   exit "$fallback_status"
fi
exit 1
 