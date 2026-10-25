# Demo Project task table

Synthetic plan for the Sandboard demo. Every task, person and figure here is made up.

## P1. Discovery

| ID | Job | Task | Sub-task | Expected result | Check | Prerequisites | Est. h | Pilot | MVP | Status | % | Doer | Reviewer | Mode | Model | Effort | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| DT101 | J1 Research | T1 Interviews | Interview five sample users | Notes from five sessions | DOC | — | 3 | Yes | Yes | Done | 100% | Agent A | Agent B | Chat | Large | High | Evidence: [interview notes](../notes/DT101-findings.md); Approved: PR #3 |
| DT102 | J1 Research | T2 Market scan | List similar tools | A comparison table | DOC | DT101 | 3 | Yes | Yes | Done | 100% | Agent B | Agent A | Chat | Large | Medium | Evidence: [scan](scan.md); merge verdict from the reviewing agent; no owner approval yet |
| DT103 | J1 Research | T3 Sizing | Estimate the audience size | A range with its sources | DOC | DT101 | 2 | Yes | Yes | Ready for Review | 80% | Agent A | Agent B | Chat | Large | High | Checks green; waiting for review |
| DT104 | J1 Research | T1 Interviews | Summarise what users asked for | A one-page summary | DOC | DT101 | 1 | Yes | Yes | Done | 100% | Agent B | Agent A | Chat | Large | Medium | Evidence: [summary](../notes/DT104-summary.md), [old copy](../../outside.md); Approved: PR #3 |

## P2. Definition

| ID | Job | Task | Sub-task | Expected result | Check | Prerequisites | Est. h | Pilot | MVP | Status | % | Doer | Reviewer | Mode | Model | Effort | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| DT201 | J2 Scope | T4 Feature list | Agree the first feature list | A list the owner accepts | DOC | DT102 | 4 | Yes | Yes | In Progress | 50% | Agent A | Agent B | Chat | Large | High | Draft shared, see the brief |
| DT201.1 | J2 Scope | T4 Feature list | Try the list with two sample users | Notes from two sessions | DOC | — | step | Yes | Yes | In Progress | 0% | Agent A | Agent B | Chat | Large | High | Step of DT201 |
| DT202 | J2 Scope | T5 Trace | Trace each feature to a check | Every feature has a check | DOC | DT201, DT999 | TBE | Yes | Yes | Not Started | 0% | Agent B | Agent A | Chat | Large | Medium | Waits on DT201; DT999 is not in this table |
| DT203 | J2 Scope | T6 Long plan | Write the old long plan | — | DOC | — | TBE | No | No | Removed | 0% | Agent A | Agent B | Chat | Large | High | Replaced by DT201 |

## P3. Access check

| ID | Job | Task | Sub-task | Expected result | Check | Prerequisites | Est. h | Pilot | MVP | Status | % | Doer | Reviewer | Mode | Model | Effort | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| DT301 | J3 Access | T7 Proof | Prove read access | — | CODE | — | TBE | No | No | Removed | 0% | Agent B | Agent A | Code | Large | High | Folded into DT401 |
| DT302 | J3 Access | T7 Proof | Write the access note | — | DOC | — | TBE | No | No | Removed | 0% | Agent A | Agent B | Chat | Large | High | Folded into DT401 |

## P4. First build

| ID | Job | Task | Sub-task | Expected result | Check | Prerequisites | Est. h | Pilot | MVP | Status | % | Doer | Reviewer | Mode | Model | Effort | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| DT401 | J4 App | T8 Reader | Read the plan file | Tasks shown from the file | CODE | DT201 | 6 | Yes | Yes | Blocked | 20% | Agent B | Agent A | Code | Large | High | Blocked until DT202 starts |
| DT402 | J4 App | T9 Views | Build the task views | Task list and details | CODE | DT401 | 8 | Yes | Yes | Not Started | 0% | Agent A | Agent B | Code |  |  | Model not chosen yet |

## P5. Private pilot

| ID | Job | Task | Sub-task | Expected result | Check | Prerequisites | Est. h | Pilot | MVP | Status | % | Doer | Reviewer | Mode | Model | Effort | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| DT501 | J5 Pilot | T10 Use | Use the app for two weeks | A list of findings | TEST | DT402 | TBE | Yes | Yes | Not Started | 0% | Agent B | Agent A | Code | Large | High | Estimate after DT402 |

## P6. Release

| ID | Job | Task | Sub-task | Expected result | Check | Prerequisites | Est. h | Pilot | MVP | Status | % | Doer | Reviewer | Mode | Model | Effort | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| DT601 | J6 Release | T11 Launch | Publish the first version | A public page | OPS | DT501 | TBE | No | Yes | Not Started | 0% | Agent A | Agent B | Code | Large | High | Needs the owner's go-live |

## P7. Grow

| ID | Job | Task | Sub-task | Expected result | Check | Prerequisites | Est. h | Pilot | MVP | Status | % | Doer | Reviewer | Mode | Model | Effort | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| DT701 | J7 Grow | T12 Extras | Plan extra features | — | DOC | — | TBE | No | No | Removed | 0% | Agent B | Agent A | Chat | Large | Medium | Later, not in this plan |
