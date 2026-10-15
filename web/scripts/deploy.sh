#!/usr/bin/env bash
# Publish web/dist to the gh-pages branch (GitHub Pages).
# The site includes generated data under data/, which the repo's .gitignore
# excludes, so files are force-added in a clean clone of the branch.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build
remote=$(git remote get-url origin)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if git ls-remote --exit-code --heads "$remote" gh-pages >/dev/null; then
  git clone --quiet --depth 1 --branch gh-pages "$remote" "$tmp"
else
  git init --quiet -b gh-pages "$tmp"
  git -C "$tmp" remote add origin "$remote"
fi

find "$tmp" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R dist/. "$tmp/"
touch "$tmp/.nojekyll"

git -C "$tmp" add -A --force
if git -C "$tmp" diff --cached --quiet; then
  echo "Nothing changed; not publishing."
  exit 0
fi
git -C "$tmp" commit --quiet -m "Deploy $(git rev-parse --short HEAD)"
git -C "$tmp" push --quiet origin gh-pages
echo "Published to gh-pages."
