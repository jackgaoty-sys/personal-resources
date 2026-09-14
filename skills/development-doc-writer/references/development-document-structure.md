# Development Document Structure

Use this reference when creating a development document or substantially reorganizing one. Adapt headings to the project; the sequence is a decision aid, not a mandatory template.

All document prose, headings, table labels, status descriptions, and conclusions produced from this structure must be written in Simplified Chinese. Preserve commands, identifiers, paths, API names, configuration keys, and commit hashes verbatim.

## Main Development Document

### 1. Current snapshot

Place a compact fact block near the title:

- audience and document date;
- current status;
- working branch and upstream baseline;
- release/deployment version, when applicable;
- maintenance or merge direction;
- commit/push state when that boundary matters.

Follow it with one paragraph that explains the project in plain language and identifies what it is not.

### 2. Boundaries and invariants

Use a short table for differences between upstream, the project branch, and the resulting behavior. State security, compatibility, data ownership, execution, and release invariants that must survive future changes.

### 3. Architecture and runtime path

Include only the topology needed to understand responsibility and isolation boundaries. A small text flow is often enough:

```text
client → authenticated API → tenant state → runtime core → isolated execution/storage
```

Separate development, test, and production runtime paths when they materially differ.

### 4. Current engineering state

Record branch/baseline, working-tree state, rollback point, environment, and active deployment. Do not say “clean”, “pushed”, or “deployed” without checking.

### 5. Development timeline

Use one consistent chronological direction, preferably oldest-to-newest:

| 日期 | 里程碑 | 状态 | 结果/证据 | 下一检查点 |
|---|---|---|---|---|

Rules:

- one row per meaningful milestone, not per command;
- place new rows at their chronological position;
- update the existing row when verification or deployment advances the same milestone;
- use exact dates; add time or sequence when same-day order is relevant;
- keep code, deployment, and manual-verification scope visible in the status or result.

### 6. Implemented work

Group by capability or subsystem, not by conversation turn. For each subsection, cover only what materially helps future development:

- goal or defect;
- root cause or design decision;
- changed behavior and preserved boundary;
- validation evidence;
- remaining limitation.

### 7. Verification summary

Summarize results by risk area. Link to the detailed test log instead of reproducing every case. Keep these categories distinct where relevant:

- build and static checks;
- unit/integration/race tests;
- security and tenant isolation;
- external services;
- deployment smoke tests;
- real-user end-to-end verification.

### 8. Blockers and priorities

Name the blocking condition, affected scope, and unblocking evidence. Order future work by impact (`P0`, `P1`, `P2`) or by release gate. Avoid vague items such as “continue testing”.

### 9. Developer verification path

Include commands or steps only when they are stable and safe to reproduce. Do not embed credentials. Point to environment files by path and variable names only when necessary.

### 10. File index

Include this only when several maintained artifacts must be navigated together. Each entry should explain ownership or purpose, not merely repeat a filename.

## Detailed Test Log

At the top, record branch, baseline, environment, authorization constraints, and allowed result values.

Use stable IDs and this minimum schema:

| 编号 | 测试项目 | 测试结果 | 修改内容 | 修改后预期/实际效果 |
|---|---|---|---|---|

Recommended ID families include `ENV`, `BUILD`, `UNIT`, `REG`, `SEC`, `ISOLATE`, `REAL`, and `DEPLOY`; reuse a project’s existing families when present.

For each row:

- define the tested scope precisely;
- retain the original failure and fix when that history explains the result;
- distinguish automated, simulated, real-service, and manual verification;
- write `无` when no code or configuration change was required;
- explain why skipped or blocked tests cannot run;
- record cleanup of temporary cloud resources when relevant.

Keep known non-blocking warnings separate from failures. A warning is non-blocking only when its impact and reason are understood.

## Update Matrix

| 发生的变化 | 必须更新的位置 |
|---|---|
| feature added or fixed | feature summary; detailed test row if tested |
| test result changed | detailed test row; main verification summary |
| milestone, blocker, or checkpoint changed | timeline; blockers/priorities |
| upstream baseline changed | snapshot; branch state; integration milestone |
| runtime or deployment changed | current state; deployment evidence; rollback point |
| commit or push occurred | Git state only after verification |
| release gate changed | priorities and status summary |

## Anti-patterns

- A handoff-style narrative that hides the current state behind chronology.
- A timeline sorted by insertion order rather than date.
- Repeating the same work in the timeline, feature section, test section, and conclusion with no added value.
- Calling code “complete” when it is only built or locally tested.
- Recording intended commands as if they were executed.
- Copying secrets or personal test-account data into the document.
- Letting old blockers remain after they were resolved, or deleting failure history that is needed to understand the fix.
