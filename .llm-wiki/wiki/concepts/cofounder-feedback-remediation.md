---
type: concept
title: Cofounder feedback remediation
created: 2026-10-27
updated: 2026-10-27
---

# Cofounder feedback remediation

A resumable workflow for turning one Cofounder feedback record or Braintrust trace into an approved root-cause analysis, a reproducing eval, a minimal fix, and a draft PR. It uses Slack or the terminal for human direction, keeps production data in a local cache, checks all outbound content for customer identifiers, and isolates implementation in pooled worktrees.

## Acceptance gates

- Identify the session and read the complete narrative before diagnosing.
- Check whether a later change already fixed the failure.
- Obtain the invoking user's approval before implementation.
- Prove the eval fails on the unmodified baseline and passes with the fix.
- Run project CI checks and publish only a draft PR.
- Release the worktree and remove local production-data dumps at closeout.
