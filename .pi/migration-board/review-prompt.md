# Deliberation Review & Prompt Improvement Prompt

Use this prompt after a deliberation run to assess agent behaviour, identify prompt weaknesses, and propose specific improvements to agent definitions and the harness.

## Usage

Point this at a completed deliberation session:

```bash
# Replace <session-id> with the actual session directory name
DELIB_DIR=".pi/migration-board/deliberations/<session-id>"
PROPOSAL_DIR=".pi/migration-board/proposals/<session-id>"

# Feed to Claude or a PI session with full context
cat <<EOF
$(cat review-prompt.md)

## Session Files

### conversation.jsonl
$(cat $DELIB_DIR/conversation.jsonl)

### tool-use.jsonl
$(cat $DELIB_DIR/tool-use.jsonl)

### memo.md
$(cat $PROPOSAL_DIR/memo.md)

### proposal.html (if exists)
$(cat $PROPOSAL_DIR/proposal.html 2>/dev/null || echo "NOT GENERATED")
EOF
```

---

## Review Instructions

You are reviewing a completed multi-agent deliberation session from the AWS Migration Board — a PI coding agent extension that orchestrates specialist agents (architecture + funding) to produce migration proposals.

Analyse the session artifacts below and produce a structured assessment covering ALL of the following areas.

### 1. Agent Participation Analysis

For each agent that participated:

| Agent | Messages | Reads | Writes | Scratch Pad Updated? | Quality Assessment |
|-------|----------|-------|--------|---------------------|-------------------|

- Did every agent read AND write their scratch pad?
- Did any agent fail to respond or produce empty output?
- Did the Solution Architect update its scratch pad between rounds?
- Were all agents listed in the board configuration actually invoked?

### 2. Deliberation Quality

- **Round count**: How many rounds of converse did the SA drive? Was this sufficient given the complexity?
- **Targeting**: Did the SA use targeted converse (specific agents) or only broadcast? Good deliberations mix both.
- **Tension surfacing**: Did agents genuinely disagree? List specific disagreements and whether they were resolved.
- **Follow-up quality**: Did the SA probe deeper on contentious points or accept first-round answers?
- **Constraint awareness**: Did the SA manage time/budget constraints appropriately, or did it run out?

### 3. Agent Prompt Effectiveness

For each agent, assess whether their system prompt produced the expected behaviour:

- **Cost Optimizer**: Did it anchor on real pricing data from context files? Did it challenge over-provisioning? Did it propose specific instance types with cost justification?
- **Reliability Engineer**: Did it address HA/DR, multi-AZ, RTO/RPO? Did it push back on cost-cutting that compromises availability?
- **Security & Compliance**: Did it address the specific compliance requirements from the brief? Did it propose concrete security controls?
- **Migration Strategist**: Did it propose a wave plan with dependency ordering? Did it consider rollback strategies?
- **Modernization Advocate**: Did it challenge lift-and-shift assumptions? Did it propose specific managed service alternatives with justification?
- **MAP Funding**: Did it assess MAP eligibility correctly? Did it estimate credit amounts?
- **Partner Incentives**: Did it identify applicable partner programs? Did it explain stacking strategies?
- **EDP & Commitments**: Did it propose a commitment strategy with break-even analysis? Did it consider Savings Plans vs RIs?

### 4. Output Quality

- **Memo completeness**: Does the memo cover all required sections (Executive Summary, Architecture, VM Mapping, Wave Plan, Cost Breakdown, Funding, Net Cost, Trade-offs, Next Steps)?
- **HTML generation**: Was proposal.html generated? Is it complete with no placeholder text?
- **Pricing accuracy**: Did agents use numbers from the context files or hallucinate prices? Flag any suspected hallucinated values.
- **Actionability**: Are the next steps specific with owners and timelines, or vague?

### 5. Prompt Improvement Recommendations

Based on the analysis above, propose specific changes. For each recommendation:

```
AGENT: [agent name or "harness"]
FILE: [file path]
ISSUE: [what went wrong or was suboptimal]
CURRENT: [relevant current prompt text, if applicable]
PROPOSED: [specific replacement text or addition]
IMPACT: [what this fix improves]
```

Focus on:
- Agents that didn't follow their persona (e.g., Cost Optimizer not challenging prices)
- Missing analysis that should have been caught (e.g., no data transfer cost estimate)
- Prompt instructions that were ignored (e.g., "write scratch pad first" not followed)
- Frontmatter expertise entries that should be added or removed
- Tool restrictions that are too tight or too loose
- System prompt sections that are too verbose (wasting context) or too vague (not actionable)

### 6. Harness / Extension Improvements

- Did the parallel execution work correctly?
- Were constraint bars accurate?
- Did meeting completion trigger at the right time?
- Any UI issues visible in the logs?
- Should the converse tool return more/less information per round?
- Should the constraint thresholds be adjusted?

### 7. Context File Gaps

- Were any context files empty/stubs when they should have had data?
- Did agents reference context files that didn't contain useful information?
- What additional context files would have improved the deliberation?
- Were pricing files at the right granularity (too detailed? too sparse?)?

### 8. Overall Score

Rate the deliberation 1-10 on each dimension:

| Dimension | Score | Notes |
|-----------|-------|-------|
| Agent diversity of opinion | /10 | Did agents bring genuinely different perspectives? |
| Depth of analysis | /10 | Were arguments substantive or surface-level? |
| Practical actionability | /10 | Can someone execute on this proposal? |
| Cost accuracy | /10 | Were numbers grounded in data or estimated? |
| Funding coverage | /10 | Were all applicable programs identified? |
| Prompt compliance | /10 | Did agents follow their system prompt instructions? |
| Output completeness | /10 | Were all required outputs generated and complete? |
| **Overall** | **/10** | |

### 9. Priority Fix List

List the top 3-5 highest-impact changes, ordered by expected improvement:

1. [Most impactful change]
2. [Second most impactful]
3. ...
