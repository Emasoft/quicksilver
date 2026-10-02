#!/bin/sh
# Quicksilver dev installer for the Emasoft fork: clone (or fast-forward) the fork, then copy the
# skill into ~/.claude/skills/quicksilver via bin/quicksilver.mjs install.
#   curl -fsSL https://raw.githubusercontent.com/Emasoft/quicksilver/main/install-dev.sh | sh
#   ... | sh -s -- --provider typesafe    (args go to `quicksilver install`; an exported key is detected)
# QUICKSILVER_DEV_DIR overrides the clone location (default ~/.local/share/quicksilver).
# --dry-run prints what it would do. An existing clone is never reset or deleted: a foreign repo or
# local changes stop the script, so a dev checkout cannot lose work.
set -eu

die() { echo "install-dev: $*" >&2; exit 1; }

# Everything runs inside main, called on the last line, so a truncated `curl | sh` download runs nothing.
main() {
  URL=https://github.com/Emasoft/quicksilver.git
  DIR=${QUICKSILVER_DEV_DIR:-$HOME/.local/share/quicksilver}
  DRY=0
  n=$#; while [ "$n" -gt 0 ]; do a=$1; shift; n=$((n - 1)); if [ "$a" = --dry-run ]; then DRY=1; else set -- "$@" "$a"; fi; done
  run() { if [ "$DRY" = 1 ]; then echo "would run: $*"; else "$@"; fi; }
  command -v git >/dev/null 2>&1 || die "git is required"
  command -v node >/dev/null 2>&1 || die "Node 18+ is required (https://nodejs.org)"
  node -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' || die "Node 18+ is required, found $(node --version)"
  if [ -e "$DIR" ]; then
    # show-toplevel must be DIR itself: a plain subfolder of another repo would report that repo's origin.
    top=$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null) || die "$DIR exists but is not a git clone; move it or set QUICKSILVER_DEV_DIR"
    [ "$top" = "$(cd "$DIR" && pwd -P)" ] || die "$DIR is inside another repo ($top); set QUICKSILVER_DEV_DIR"
    origin=$(git -C "$DIR" remote get-url origin 2>/dev/null) || die "$DIR has no origin remote"
    [ "${origin%.git}" = "${URL%.git}" ] || die "$DIR is a clone of $origin, not $URL; refusing to touch it"
    [ -z "$(git -C "$DIR" status --porcelain)" ] || die "$DIR has local changes; commit or stash them first"
    run git -C "$DIR" pull --ff-only
  else
    run git clone "$URL" "$DIR"
  fi
  [ "$DRY" = 1 ] && { echo "would run: node $DIR/bin/quicksilver.mjs install $*"; exit 0; }
  # Under curl | sh stdin is the script itself; the key prompt reads the terminal when there is one.
  if (exec </dev/tty) 2>/dev/null; then exec node "$DIR/bin/quicksilver.mjs" install "$@" </dev/tty; fi
  exec node "$DIR/bin/quicksilver.mjs" install "$@"
}

main "$@"
