# HANDOVER.md — retired

English source of truth. [Russian mirror](docs/ru/HANDOVER.md).

This file held the agent handover for TASK-074 (Pilot HUD and freshness),
dated 2026-10-20. TASK-074 is DONE and its evidence is in the
[roadmap](docs/PROJECT_ROADMAP.md). TASK-134 retired the handover on
2026-10-28 because its baseline, its Windows host notes and its next steps are
stale. The previous text remains in git history at commit `ba4e37c`.

One finding from it is still relevant: on a physical ArduPilot 4.6.3 USB port
(`SERIAL0`), the controller sends only `HEARTBEAT` passively and sends
`EKF_STATUS_REPORT` (193) only when polled with the read-only
`MAV_CMD_REQUEST_MESSAGE` (512) command. `apps/web/src/SerialConnect.tsx`
implements that poll.

Start a new iteration from [CLAUDE.md](CLAUDE.md), then
[PROJECT_SCOPE.md](PROJECT_SCOPE.md), the [Phase 1 plan](docs/PHASE1_PLAN.md)
and the selected task in the roadmap. The roadmap, not a handover file, holds
task status and evidence.
