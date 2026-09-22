---
name: first-principles-thinking
description: "Decompose problems to fundamental truths before designing solutions. Use when requirements are vague, solutions feel over-engineered, or 'we've always done it this way' is the main justification."
---

# First Principles Thinking

A reasoning tool, not a workflow. Apply it inline when the current conversation hits a decision point where convention or analogy is being used as justification.

## When to Apply

- A design choice is justified by "best practice" or "everyone does X" rather than project constraints
- Requirements feel vague and the user's real problem isn't clear yet
- A proposed solution is more complex than the problem warrants
- Multiple approaches exist and trade-offs are unclear
- Debugging reveals that an assumption "everyone knew" was wrong

Don't apply when the problem is straightforward, time-critical, or already well-understood.

## The Three Questions

Before proposing a solution, answer these:

1. **What is actually true here?** — Not what's conventional, not what worked elsewhere. What constraints exist in *this* project, *this* codebase, *this* situation?
2. **What are we assuming?** — Challenge each assumption: is it a hard constraint or just a habit? If removing it breaks nothing, it's unnecessary.
3. **What's the minimum that solves the real problem?** — Build up from truths, not down from a complex template.

## How to Apply (inline, not ceremony)

### During Requirement Clarification

When the user says "we need X":
- Restate the problem without implementation details
- Ask: what outcome matters, independent of how we get there?
- Separate "user needs Y result" from "let's build Z technology"

### During Technical Design

When evaluating approaches:
- List the constraints that are actually immovable (SLA numbers, team size, data volume)
- For each component in the proposed design: "which constraint requires this?"
- If a component doesn't trace to a constraint, it's speculative — flag it

### During Bug Analysis

When a fix feels fragile:
- What assumption was the code relying on?
- Is that assumption documented anywhere? If not, it's an implicit dependency
- Would a different structure make this assumption unnecessary?

### During Scope Discussions

When scope is growing:
- Go back to the one-sentence problem statement
- For each addition: "which user outcome does this serve?"
- If the answer is "it might be useful someday" — it's out of scope

## Anti-Patterns

| What Looks Like FP | Why It's Not |
|---------------------|-------------|
| "Let me analyze this from first principles" → then proposes the conventional solution anyway | FP requires challenging the conventional answer, not confirming it |
| 20-minute axiom derivation for a 5-minute decision | FP is a thinking tool, not a ritual. Apply proportional effort |
| "Ground truth: we need a database" | That's a technology choice, not a truth. The truth is "data must persist across sessions" |

## Related Skills

- `requirement-workshop` — FP thinking is built into the First Principles section there; this skill goes deeper
- `technical-design` — use FP when evaluating multiple approaches
- `root-cause-review` — complementary: FP challenges assumptions, RCA tracks evidence
