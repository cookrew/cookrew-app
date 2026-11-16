// cr-disclaim <program> [args...]
//
// Becomes <program> (same pid, same parent, same stdio) with macOS
// "responsibility" disclaimed, so <program> answers for itself to TCC instead
// of to Cookrew.
//
// Why: a browser card's Chrome hard-links its own executable into a code-sign
// clone at launch. Started straight from Cookrew, Cookrew is the responsible
// app, App Management refuses the write and macOS shows "Cookrew was prevented
// from modifying apps on your Mac" (measured 2026-11-16, Chrome 157). Chrome
// answering for itself may touch its own bundle, so nothing is refused and
// nothing is shown. headless-chrome.ts falls back to a direct spawn without it.
//
// responsibility_spawnattrs_setdisclaim is the libsystem call Terminal-style
// apps and Chromium use for the same purpose. It is not in the public headers,
// so it is looked up at run time: a macOS without it still starts Chrome, only
// without the disclaim.

#include <dlfcn.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>

extern char **environ;

typedef int (*setdisclaim_fn)(posix_spawnattr_t *attrs, int disclaim);

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: cr-disclaim <program> [args...]\n");
    return 64;
  }
  posix_spawnattr_t attrs;
  if (posix_spawnattr_init(&attrs) != 0) {
    perror("cr-disclaim: posix_spawnattr_init");
    return 127;
  }
  // SETEXEC: replace this process rather than fork a child, so the caller's
  // pid, signals and exit status are Chrome's own. Without it posix_spawn
  // would fork a Chrome nobody tracks, so its failure is fatal.
  if (posix_spawnattr_setflags(&attrs, POSIX_SPAWN_SETEXEC) != 0) {
    fprintf(stderr, "cr-disclaim: cannot set POSIX_SPAWN_SETEXEC\n");
    return 127;
  }
  setdisclaim_fn setdisclaim = (setdisclaim_fn)dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim");
  if (setdisclaim == NULL || setdisclaim(&attrs, 1) != 0) {
    fprintf(stderr, "cr-disclaim: could not disclaim responsibility, starting anyway\n");
  }
  int rc = posix_spawn(NULL, argv[1], NULL, &attrs, argv + 1, environ);
  // Only reached when the exec did not happen.
  fprintf(stderr, "cr-disclaim: cannot start %s: %s\n", argv[1], rc != 0 ? strerror(rc) : "exec returned");
  return 127;
}
