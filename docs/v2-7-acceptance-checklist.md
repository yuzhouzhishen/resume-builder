# Resume Builder V2.7 Acceptance Checklist

Date: 2026-07-12

## Automated Release Gate

- [x] `TZ=UTC npm test` passes the complete test suite.
- [x] Repository privacy scanning covers the current tree and full reachable history.
- [x] Launcher tests cover Node version checks, dependency decisions, Chromium decisions and matching-server reuse.
- [x] Browser command construction is covered for macOS, Windows and Linux.
- [x] Preview-to-form selection places input and textarea carets at the end of existing text.
- [x] `git diff --check` reports no whitespace errors.

## macOS Manual Acceptance

- [x] The Downloads shortcut opens the project launcher successfully.
- [x] The launcher starts the local editor and opens the browser.
- [x] Preview field selection scrolls to the matching editor control and leaves it ready to edit.
- [ ] A second double-click while the same data-root server is running reopens it without starting another process.
- [ ] `Ctrl+C` stops the launched service and a later double-click starts it again.
- [ ] A clean machine without `node_modules` completes npm and Chromium preparation successfully.

## Windows Manual Acceptance

- [ ] Install Node.js `20.12+` and clone the repository on a real Windows computer.
- [ ] Double-click `whoami_.cmd` and confirm dependencies, Chromium, service startup and browser opening.
- [ ] Confirm a second launch reuses the running matching instance.
- [ ] Confirm `Ctrl+C` stops the service and startup errors remain visible.
- [ ] Install Poppler on `PATH` and generate a standard one-page A4 PDF and PNG.

Windows items remain explicit post-release environment checks. Their platform command and decision logic are automated, but V2.7 does not claim real Windows execution evidence until these boxes are completed.

## Functional Smoke Check

- [x] Existing resume content can be edited, previewed, saved and formally generated.
- [x] Preview clicking selects the correct profile, experience, skill, project and bullet controls.
- [x] Undo and redo work during the current editing session.
- [x] Real resume data remains outside the Git repository.
