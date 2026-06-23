# Agent Website Design Workflow

Date: 2026-06-22

This workflow is for testing creative, section-by-section website design with the
agent. It keeps design work structured before implementation, separates design QA
from rendered implementation QA, and treats both QA stages as evidence-backed
loops.

## Structured Output Plan

Every agent response can include a `designWorkflow` object. Non-design tasks
return an empty workflow. Website and UI design tasks fill the relevant steps.

1. `brand-story`
   - Output kind: `brief`
   - Captures brand name, audience, positioning, mood, narrative tension, and
     sensory anchors.

2. `information-architecture`
   - Output kind: `sitemap`
   - Captures page sections, section order, primary user paths, and CTA priority.

3. `creative-direction`
   - Output kind: `style-system`
   - Captures visual references, color roles, typography mood, photography
     direction, spacing rhythm, and interaction tone.

4. `section-design`
   - Output kind: `section-spec`
   - Captures `sectionDesigns` entries with section id, story role, layout,
     elements, visual assets, asset placement, CTAs, responsive notes, and
     acceptance criteria.

5. `responsive-layout`
   - Output kind: `breakpoint-rules`
   - Captures `responsiveRules` entries with viewport, layout, typography,
     navigation, asset behavior, and constraints.

6. `interaction-motion`
   - Output kind: `interaction-spec`
   - Captures `interactionRules` entries with trigger, target, feedback, motion,
     accessibility, and reduced-motion behavior.

7. `accessibility-review`
   - Output kind: `accessibility-checklist`
   - Captures `accessibilityChecks` entries with target, requirement, inspection
     method, status, and fix guidance.

8. `qa-review`
   - Output kind: `qa-report`
   - Captures evidence-backed defects, severity, viewport results, fix plan,
     resolved and remaining issues, stop condition, and next action.

9. `code-generation`
   - Output kind: `implementation-plan`
   - Captures target files, components, assets, constraints, implementation
     notes, and acceptance criteria.
   - Starts only after design QA passes or remaining design issues are explicitly
     accepted.

10. `implementation-qa`
    - Output kind: `runtime-qa-report`
    - Captures rendered checks, build evidence, responsive behavior,
      accessibility, interaction behavior, performance risk, content integrity,
      runtime defects, and fix plan.

11. `final-polish`

- Output kind: `polish-report`
- Captures `polishChecks` entries for story continuity, visual cohesion, spacing
  rhythm, typography consistency, CTA clarity, and accepted risks.

## Execution Plan

The agent should move through the workflow in this order:

```text
brand story
information architecture
creative direction
section design
responsive layout
interaction and motion
accessibility review
design QA loop
code generation
implementation QA loop
final polish
```

Each step is intended to run as its own model call through OpenRouter. OpenRouter
is used as the routing layer so the agent can choose different models for
different steps without changing the workflow contract.

Every step call has:

- a step id
- a model id
- a step-specific prompt
- the previous structured workflow as input context
- the strict `DesignWorkflowOutput` JSON schema
- local validation after the model returns
- a repair prompt when output fails validation

The current default model routing is:

| Step                       | Default OpenRouter model      |
| -------------------------- | ----------------------------- |
| `brand-story`              | `google/gemini-2.5-flash`     |
| `information-architecture` | `google/gemini-2.5-flash`     |
| `creative-direction`       | `google/gemini-2.5-flash`     |
| `section-design`           | `anthropic/claude-3.5-sonnet` |
| `responsive-layout`        | `google/gemini-2.5-flash`     |
| `interaction-motion`       | `google/gemini-2.5-flash`     |
| `accessibility-review`     | `anthropic/claude-3.5-sonnet` |
| `qa-review`                | `openai/gpt-4.1`              |
| `code-generation`          | `anthropic/claude-3.5-sonnet` |
| `implementation-qa`        | `openai/gpt-4.1`              |
| `final-polish`             | `google/gemini-2.5-flash`     |

The model map is configurable per run. The runner sends OpenRouter chat
completion requests with `response_format.type = "json_schema"` and the strict
workflow schema. Local validators remain the final gate, because schema-valid
JSON can still be weak or internally inconsistent.

The app exposes this workflow through the `openrouter-design` agent provider.
That provider does not store credentials in the app. It reads
`OPENROUTER_API_KEY` from the agent host process environment, runs the requested
step or full workflow, and returns `designWorkflow` in the normal
`AgentSessionResult`.

For section-by-section design, the agent should run steps 4-8 for each major
section before moving to implementation. For example, the cafe hero must pass
design QA before the agent generates code for that hero.

## Design QA Loop

The design QA step follows this loop:

```text
inspect structured design and available visual evidence
detect defects
classify severity
produce fix plan
revise the design spec when allowed
re-assess the design spec
stop only when issues pass, are accepted, or are blocked by missing evidence
```

QA issue categories are:

- `visual-layout`
- `responsive`
- `content-quality`
- `accessibility`
- `interaction`
- `brand-story`
- `performance`

QA evidence must identify how the defect was found: screenshot, viewport check,
accessibility check, performance check, source review, or manual inspection. If
visual inspection is not available, the agent must mark affected viewports as
`not-checked` and explain the evidence gap.

## Code Generation Gate

The agent may generate code only when one of these conditions is true:

- Design QA status is `pass`.
- Remaining design QA issues are marked `accepted`.
- The user explicitly asks to proceed despite unresolved design QA issues.

The `codeGeneration` payload must include:

- `targetFiles`
- `components`
- `assets`
- `constraints`
- `implementationNotes`
- `acceptanceCriteria`

For the sample cafe hero, code generation should preserve these constraints:

- light-only visual language
- no dark panels or dark IDE-like framing
- no card-based hero container
- full-bleed image-led composition
- accessible text contrast over the image
- stable responsive CTA layout

## Implementation QA Loop

The implementation QA step follows this loop:

```text
build or render the implementation
inspect runtime evidence
detect implementation defects
classify severity
produce fix plan
apply reviewable fixes when allowed
re-render or rebuild
stop only when runtime checks pass, are accepted, or are blocked by missing evidence
```

Implementation QA checks are:

- `build`
- `rendered-layout`
- `responsive`
- `accessibility`
- `interaction`
- `performance`
- `content-integrity`

Implementation QA must not claim success without rendered or build evidence. If
runtime inspection cannot run, the agent must set `implementationQa.status` to
`blocked` and explain the missing evidence.

For the sample cafe test, the QA question is:

```text
Does this hero feel like Lumen & Loaf, or could it belong to any cafe?
```

If it could belong to any cafe, that is a `brand-story` defect even when the
layout is technically clean.
