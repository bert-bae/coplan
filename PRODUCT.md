# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Developers who steer a coding agent (Claude Code, Codex or Cursor). They open Coplan to review and reshape the agent's plan visually before it builds, then to follow the build. Teammates may read exported plans (Markdown, PDF) but are not the primary audience.

## Product Purpose
Give the agent's plan a place to live outside the chat. The agent publishes its design as architecture diagrams with the tasks it plans linked to the boxes they build; the user reshapes it and confirms the design; the agent breaks it into a task list, the user submits it, and the same page follows each task across the board during the build.

## Positioning
The plan lives outside chat: diagrams linked to tasks, explicit confirm-then-submit gates, and the same page following the build. Open source, runs entirely locally (daemon, browser UI, one plugin), no account, no telemetry. Works the same across Claude Code, Codex and Cursor.

## Operating Context
A small local daemon serves a browser UI next to the agent's terminal or editor. Plans can be exported as Markdown, a standalone page, a per-diagram PNG, or a PDF made through the browser's print dialog ("Save as PDF").

## Capabilities and Constraints
- Views: Overview, Architecture (diagram canvas), Tasks, and a board during a build.
- The PDF export covers the overview and architecture, with each diagram drawn off screen and embedded as a PNG (`src/ui/components/PdfExport.tsx`, `src/artifact/render.ts`).
- Print output must work in any browser: no features that need a specific engine.
- No new dependencies: keep the UI lean; no extra fonts or libraries.

## Brand Commitments
Name: Coplan. Open source under the MIT license. No other binding visual commitments were stated.

## Evidence on Hand
Real product screenshots in `docs/images/` (architecture, tasks, submit, board). No testimonials, customer logos or benchmarks exist; do not invent them.

## Product Principles
- The plan is the product: the page shows it faithfully and never decides for the user.
- Every change goes through an explicit gate (confirm the design, submit the plan).
- Local and private by default: no account, no hosted service, no telemetry.
- Same experience for every supported agent.
