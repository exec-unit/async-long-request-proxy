# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for `async-long-request-proxy`.

ADRs capture non-obvious architectural decisions - the why behind choices that are not immediately apparent from reading the code. When a decision has significant consequences, affects multiple components, or involves meaningful trade-offs, an ADR is written.

## Index

| ADR                                             | Title                                                             | Status   |
| ----------------------------------------------- | ----------------------------------------------------------------- | -------- |
| [ADR-001](001-double-202-pattern.md)            | Double 202 Pattern                                                | Accepted |
| [ADR-002](002-db-level-state-machine.md)        | State Machine Enforced at the Database Level                      | Accepted |
| [ADR-003](003-two-phase-idempotency-lock.md)    | Two-Phase Idempotency Lock in Redis                               | Accepted |
| [ADR-004](004-sse-event-sourcing.md)            | SSE via Event Sourcing + Redis Pub/Sub                            | Accepted |
| [ADR-005](005-api-worker-process-separation.md) | API and Worker as Separate Processes from One Codebase            | Accepted |
| [ADR-006](006-timeout-sweeper.md)               | Timeout Sweeper with FOR UPDATE SKIP LOCKED                       | Accepted |
| [ADR-007](007-dispatch-error-strategy.md)       | Dispatch Error Strategy - Revert vs. Permanent Failure            | Accepted |
| [ADR-008](008-callback-token-security.md)       | Callback Token Security - Per-Task UUID, Constant-Time Comparison | Accepted |

## Adding a new ADR

1. Copy the template structure from an existing ADR
2. Increment the number: `009-your-decision.md`
3. Fill in Context, Decision, and Consequences
4. Add a row to this index
5. Reference the ADR in relevant code comments where the decision is implemented

## Format

ADRs in this project follow the lightweight format from [Michael Nygard](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions):

- Status - current state of the decision
- Context - the problem and its constraints
- Decision - what was decided
- Consequences - outcomes, both positive and negative
