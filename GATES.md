# Gates: mobile reel operations dashboard

OWNS: dashboard/**, scripts/verify-dashboard.mjs, README.md, GATES.md

Scope: deliver a production-usable, mobile-first operations dashboard that exposes live workflow progress, node state, execution diagnostics, scheduling, service health, and rendered outputs.

- [x] G1: dashboard APIs expose ordered workflow nodes and per-execution node states needed for live progress
  CHECK: npm test && node -e "console.log('dashboard API verification passed')"
  EXPECT: dashboard API verification passed
  CWD: dashboard
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/dextron/Documents/ChatGPT/auto-reel-creation/dashboard; path=edf9c48d7f07/27 entries; output=ℹ duration_ms 95.6425 | dashboard API verification passed

- [x] G2: dashboard markup and client behavior include live polling, node progress, actionable failures, mobile navigation, schedule controls, and video output access
  CHECK: node scripts/verify-dashboard.mjs
  EXPECT: dashboard capability verification passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/dextron/Documents/ChatGPT/auto-reel-creation; path=edf9c48d7f07/27 entries; output=dashboard capability verification passed

- [x] G3: renderer regressions remain green after dashboard integration changes
  CHECK: npm test && node -e "console.log('renderer regression verification passed')"
  EXPECT: renderer regression verification passed
  CWD: renderer
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/dextron/Documents/ChatGPT/auto-reel-creation/renderer; path=edf9c48d7f07/27 entries; output=ℹ duration_ms 177.689542 | renderer regression verification passed

- [x] G4: desktop and 390px mobile dashboard renders are visually reviewed for hierarchy, legibility, active-node visibility, touch targets, and overflow
  EVIDENCE: Reviewed the real idle dashboard and mock active execution at 1440x900 and 390x844. The live monitor is above the desktop fold; the mobile view has no horizontal overflow, exposes the active node and 43-node stage rail, and provides at least 44x44px visible controls (50x50px primary run action).

- [x] G5: the final repository diff is structurally clean
  CHECK: git diff --check && node -e "console.log('dashboard diff verification passed')"
  EXPECT: dashboard diff verification passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/dextron/Documents/ChatGPT/auto-reel-creation; path=edf9c48d7f07/27 entries; output=dashboard diff verification passed
