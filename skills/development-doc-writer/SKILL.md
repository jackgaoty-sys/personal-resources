---
name: development-doc-writer
description: Create, restructure, or maintain Simplified Chinese project development documents and test logs from verified repository, Git, test, and deployment evidence. Use for living engineering progress documents; do not use for handoff reports, release notes, or ordinary status summaries unless the user explicitly wants them converted into a maintained development document.
---

# Development Document Writer

Maintain a living engineering document that answers: what the project is, where it stands now, what changed, why it changed, what evidence exists, what remains blocked, and what happens next.

## Language Requirement

Write all generated or edited development documents and test logs in Simplified Chinese. Keep source-code identifiers, commands, paths, API names, configuration keys, commit hashes, product names, and established technical terms in their original form when translation would reduce precision. Do not switch the narrative, headings, table labels, status descriptions, or conclusions to English.

## Evidence First

Before writing, inspect the relevant project instructions, existing development documents, Git state, changed files, tests, and deployment state. Prefer observable repository and runtime facts over stale prose or conversational assumptions.

Distinguish these evidence dimensions; never collapse them into one “completed” claim:

- code implemented;
- automated tests passed;
- artifact built;
- environment deployed;
- real-user or real-service verification completed;
- commit created;
- push completed.

Record a user decision as a decision. Do not present its expected effect as verified behavior until evidence exists.

## Choose the Smallest Document Set

- Update an existing development document when it already serves the project.
- Keep detailed test cases in an existing test log when one exists; summarize only material results in the main document.
- Create a separate test log only when the volume or repeatability of tests would overwhelm the main document.
- Do not create a handoff report, work report, changelog, or maintenance-rules section unless the user asks for it or the repository already relies on it.

For a new document or a substantial restructure, read both:

- [references/development-document-structure.md](references/development-document-structure.md) for the document model and update rules;
- [references/cloud-development-document-few-shot.zh-CN.md](references/cloud-development-document-few-shot.zh-CN.md) for a sanitized example of the intended structure, evidence density, and separation between the main document and test log.

Treat the Few-shot as a writing example only. Its names, dates, commits, routes, environments, counts, and technical choices are synthetic; never copy them into a real project without independent verification.

## Update Workflow

1. Establish the current branch, baseline, working-tree state, deployment version, and explicit authorization boundaries.
2. Locate the existing milestone, feature, test, or blocker entry before adding a new one. Update the existing entry when it describes the same work.
3. Insert timeline entries in one consistent chronological direction. Prefer oldest-to-newest for a development progression; never place a later date between earlier dates. Within one date, preserve actual sequence or include a time/order marker.
4. Describe each material change as a compact chain: problem or goal → implementation → verification → expected/observed effect → remaining work.
5. Update the detailed test log first when tests were run, then synchronize the main document’s summary, timeline, blockers, and priorities.
6. Re-read all status claims after editing. Downgrade any claim that lacks the evidence implied by its wording.

## Status Vocabulary

Use explicit, non-overlapping states:

- `规划` or `待测试`: not started or not yet verified;
- `进行中`: implementation or verification is incomplete;
- `阻塞`: a named external condition prevents progress;
- `失败`: an executed check did not meet acceptance criteria;
- `通过`: the named test scope passed;
- `完成`: implementation and the document’s stated acceptance scope are complete.

Add qualifiers when scope matters, such as `通过（本地自动化）`, `完成（已部署，待真实账号复验）`, or `阻塞（缺少裸 Linux 环境）`. Never use `通过` for a test that was not executed.

## Writing Rules

- Lead with current outcome and project boundary, then provide supporting detail.
- Keep the main document navigable: current snapshot, ordered timeline, concise feature summaries, verification summary, blockers, and next priorities.
- Keep historical facts, current facts, and future plans visibly separate.
- Use stable test IDs and preserve earlier failure context when a later fix passes.
- State exact commands, commit hashes, versions, dates, and environments only when verified and useful for reproduction.
- Avoid duplicated narrative. Link to design, deployment, or test documents instead of copying them.
- Do not include access tokens, passwords, cookies, private keys, signed URLs, `.env` contents, personal account data, or unnecessary infrastructure secrets.
- Do not alter source code, run tests, deploy, commit, or push merely because the document mentions those actions. Perform only actions separately authorized by the user.

## Final Check

Confirm that:

- the newest project state is clear without reading the full history;
- timeline dates are strictly ordered;
- every completion claim names its evidence or scope;
- unresolved work appears once in blockers or priorities, not as contradictory statements throughout the document;
- Git and deployment statements match the inspected state;
- sensitive values are absent;
- links and referenced paths resolve.
