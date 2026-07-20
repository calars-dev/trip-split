#!/usr/bin/env bash
# Deploy Trip Split to GitHub Pages under the calars-dev account.
# Run from the project root:  bash deploy.sh
#
# NOTE on accounts: this repo belongs to the personal `calars-dev` GitHub account.
# gh's ACTIVE account may currently be `farax-creative`. Switching the active
# account affects any other running Claude session — do this only when no other
# session is pushing to a farax-creative repo. The script switches, deploys, and
# switches back.
set -e

REPO="trip-split"
PREV_ACCOUNT="$(gh auth status --active 2>/dev/null | grep -oP 'account \K[^ ]+' | head -1 || true)"

echo "→ switching gh to calars-dev"
gh auth switch --user calars-dev

echo "→ creating repo (public) and pushing"
git add -A
git commit -m "Deploy trip-split" 2>/dev/null || true
gh repo create "$REPO" --public --source=. --remote=origin --push || git push -u origin HEAD

echo "→ enabling GitHub Pages (main branch, root)"
gh api -X POST "repos/calars-dev/$REPO/pages" -f "source[branch]=main" -f "source[path]=/" 2>/dev/null || \
  echo "  (Pages may already be enabled — check repo Settings > Pages)"

if [ -n "$PREV_ACCOUNT" ] && [ "$PREV_ACCOUNT" != "calars-dev" ]; then
  echo "→ switching gh back to $PREV_ACCOUNT"
  gh auth switch --user "$PREV_ACCOUNT"
fi

echo ""
echo "✅ Done. Your app will be live in ~1 min at:"
echo "   https://calars-dev.github.io/$REPO/"
echo "   (create a room there, then share the ?r=... link)"
