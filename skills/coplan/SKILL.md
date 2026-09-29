---
name: coplan
description: Plan a feature as a structured plan the user reviews and approves in the browser before any code is written - key decisions first, then the plan (flows, edge cases, security, gaps), then vertical slices and tasks. Use when the user asks to plan, scope or design a feature before building it, wants to review a plan before implementation starts, or asks for Coplan by name.
license: MIT
compatibility: Needs the coplan command (Node.js 24 or newer) and a browser on the same machine.
---

# Coplan

Coplan turns a feature request into a plan an engineer reviews in 10-15 minutes in the browser.
The reviewer answers key decisions, comments on and approves the plan, then either approves its breakdown into vertical slices and tasks or skips slicing to have you build straight away, and every answer comes back to you as structured feedback.

## Current guidance lives in the CLI

Do not follow workflow or authoring rules from memory or from this file.
Get them from the CLI, which is the single source of truth:

- `coplan` for the workflow, rules and commands
- `coplan guide decisions` before writing the first version of a plan
- `coplan guide plan` and `coplan guide tabs` once the decisions are answered
- `coplan guide slices` after the reviewer approves the plan

Every command prints a `next_step`; follow it.
If the `coplan` command is not found, stop and ask the user to install Coplan: https://github.com/mitchglenn/coplan#install

Plans live in the project being planned, under `.coplan/<slug>/`, created by `coplan new <slug>` from the project root.

## What to plan

Plan the feature the user asked for when they invoked this skill.
If they did not name one, plan the feature under discussion in this conversation.
