import { randomUUID } from "node:crypto";

import type {
  AgentAuthStatus,
  AgentEvent,
  AgentProviderId,
  AgentSessionResult,
  AgentStartRequest
} from "@latex-agent/ipc-contracts";

import {
  createEmptyDesignWorkflowOutput,
  designWorkflowOutputSchema,
  designWorkflowStepIds,
  isValidDesignWorkflowOutput,
  type DesignWorkflowOutput,
  type DesignWorkflowStepId
} from "./design-workflow.js";

export type OpenRouterDesignModelMap = Partial<Record<DesignWorkflowStepId, string>>;

export type OpenRouterDesignStepInput = {
  readonly projectName: string;
  readonly brief: string;
  readonly stepId: DesignWorkflowStepId;
  readonly previousWorkflow?: DesignWorkflowOutput;
  readonly additionalContext?: string;
};

export type OpenRouterDesignWorkflowInput = {
  readonly projectName: string;
  readonly brief: string;
  readonly steps?: readonly DesignWorkflowStepId[];
  readonly additionalContext?: string;
};

export type OpenRouterChatMessage = {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
};

export type OpenRouterStructuredCallRequest = {
  readonly model: string;
  readonly stepId: DesignWorkflowStepId;
  readonly messages: readonly OpenRouterChatMessage[];
  readonly schema: unknown;
};

export type OpenRouterStructuredCallRunner = (
  request: OpenRouterStructuredCallRequest
) => Promise<unknown>;

export type OpenRouterDesignStepResult = {
  readonly stepId: DesignWorkflowStepId;
  readonly model: string;
  readonly attempts: number;
  readonly workflow: DesignWorkflowOutput;
};

export type OpenRouterDesignWorkflowResult = {
  readonly modelByStep: Record<DesignWorkflowStepId, string>;
  readonly steps: readonly OpenRouterDesignStepResult[];
  readonly workflow: DesignWorkflowOutput;
};

export type OpenRouterDesignWorkflowRunnerOptions = {
  readonly callModel: OpenRouterStructuredCallRunner;
  readonly modelByStep?: OpenRouterDesignModelMap;
  readonly maxRepairAttempts?: number;
};

export type OpenRouterHttpRunnerOptions = {
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly referer?: string;
  readonly title?: string;
};

export type OpenRouterDesignProviderOptions = {
  readonly apiKey?: string;
  readonly endpoint?: string;
  readonly referer?: string;
  readonly title?: string;
  readonly runner?: Pick<OpenRouterDesignWorkflowRunner, "runWorkflow">;
  readonly modelByStep?: OpenRouterDesignModelMap;
  readonly maxRepairAttempts?: number;
};

export const openRouterDesignProviderId = "openrouter-design" as const;
const defaultOpenRouterEndpoint = "https://openrouter.ai/api/v1/chat/completions";
const defaultRepairAttempts = 1;
const defaultOpenRouterDesignModels: Record<DesignWorkflowStepId, string> = {
  "brand-story": "google/gemini-2.5-flash",
  "information-architecture": "google/gemini-2.5-flash",
  "creative-direction": "google/gemini-2.5-flash",
  "section-design": "anthropic/claude-3.5-sonnet",
  "responsive-layout": "google/gemini-2.5-flash",
  "interaction-motion": "google/gemini-2.5-flash",
  "accessibility-review": "anthropic/claude-3.5-sonnet",
  "qa-review": "openai/gpt-4.1",
  "code-generation": "anthropic/claude-3.5-sonnet",
  "implementation-qa": "openai/gpt-4.1",
  "final-polish": "google/gemini-2.5-flash"
};

export const openRouterDesignWorkflowStepDefinitions: Record<
  DesignWorkflowStepId,
  {
    readonly title: string;
    readonly objective: string;
    readonly outputKind: string;
    readonly prompt: string;
  }
> = {
  "brand-story": {
    title: "Brand Story",
    objective: "Define the website's narrative foundation before structure or visuals.",
    outputKind: "brief",
    prompt:
      "Define brandName, businessType, positioning, audience, brandPromise, mood, storyPremise, sensoryAnchors, toneOfVoice, differentiators, and antiPatterns. Make the result specific enough that later steps cannot produce a generic website."
  },
  "information-architecture": {
    title: "Information Architecture",
    objective:
      "Turn the brand story into a user journey, section order, and CTA system.",
    outputKind: "sitemap",
    prompt:
      "Use the approved brand story to produce websiteStoryArc, sectionsDetailed, sectionOrder, primaryUserPaths, ctaPriority, navigationModel, contentRequirements, and handoffToCreativeDirection. Every ordered section must have a matching detailed section. Every user-path step and CTA target must reference a real section id."
  },
  "creative-direction": {
    title: "Creative Direction",
    objective:
      "Turn brand story and IA into a concrete visual system before section design.",
    outputKind: "style-system",
    prompt:
      "Use ui-ux-pro-max design intelligence categories for style selection, color, typography, layout/responsive, accessibility, touch targets, interaction states, motion, and anti-patterns. Fill colorSystem, typographySystem, imageDirection, compositionPrinciples, spacingRhythm, textureMaterialRules, iconIllustrationRules, ctaSystem, motionMood, sectionProgression, and handoffToSectionDesign. Do not design individual sections yet."
  },
  "section-design": {
    title: "Section Design",
    objective:
      "Design one or more website sections in detail using approved IA and creative direction.",
    outputKind: "section-spec",
    prompt:
      "Populate sectionDesigns with one object per designed section. Each object must include id, storyRole, layout, elements, visualAssets, assetPlacement, ctas, responsiveNotes, and acceptanceCriteria. Preserve the approved story arc and visual system."
  },
  "responsive-layout": {
    title: "Responsive Layout",
    objective:
      "Define stable behavior across mobile, tablet, desktop, and wide desktop.",
    outputKind: "breakpoint-rules",
    prompt:
      "Populate responsiveRules with viewport-specific rules. Each rule must include viewport, layout, typography, navigation, assets, and constraints. Prevent horizontal scroll, overlapping content, text overflow, and layout shift."
  },
  "interaction-motion": {
    title: "Interaction & Motion",
    objective: "Define purposeful interaction states and reduced-motion-safe behavior.",
    outputKind: "interaction-spec",
    prompt:
      "Populate interactionRules. Each rule must include trigger, target, feedback, motion, accessibility, and reducedMotion. Cover hover, press, focus, active, loading, transition, scroll, and reduced-motion behavior. Motion must clarify cause and effect and never block interaction."
  },
  "accessibility-review": {
    title: "Accessibility Review",
    objective: "Check the design spec against accessibility and usability rules.",
    outputKind: "accessibility-checklist",
    prompt:
      "Populate accessibilityChecks. Each check must include id, target, requirement, method, status, and fix. Review contrast, semantic heading order, labels, focus states, keyboard paths, tap targets, image meaning, color-not-only, readable type, and reduced motion."
  },
  "qa-review": {
    title: "Design QA",
    objective: "Find evidence-backed design defects and produce a fix loop.",
    outputKind: "qa-report",
    prompt:
      "Inspect the structured design and available evidence. Populate qa.viewportResults, qa.issues, qa.fixPlan, resolvedIssueIds, remainingIssueIds, stopCondition, and nextAction. Do not claim pass without evidence."
  },
  "code-generation": {
    title: "Code Generation",
    objective:
      "Plan or generate code only after design QA passes or issues are accepted.",
    outputKind: "implementation-plan",
    prompt:
      "Use the approved design workflow to fill codeGeneration with targetFiles, components, assets, constraints, implementationNotes, and acceptanceCriteria. Do not proceed when design QA has unresolved non-accepted defects."
  },
  "implementation-qa": {
    title: "Implementation QA",
    objective: "Inspect rendered/build evidence after code exists and loop on defects.",
    outputKind: "runtime-qa-report",
    prompt:
      "Use runtime/build evidence to populate implementationQa.checks, issues, fixPlan, resolvedIssueIds, remainingIssueIds, stopCondition, and nextAction. Do not claim pass without rendered or build evidence."
  },
  "final-polish": {
    title: "Final Polish",
    objective:
      "Confirm story continuity, visual cohesion, and remaining accepted risks.",
    outputKind: "polish-report",
    prompt:
      "Populate polishChecks. Each check must include target, criterion, status, and recommendation. Review the whole workflow for narrative continuity, visual cohesion, spacing rhythm, typography consistency, CTA clarity, and accepted risks. Do not introduce new code or section designs."
  }
};

export class OpenRouterDesignProvider {
  readonly id: AgentProviderId = openRouterDesignProviderId;
  private readonly apiKey: string | undefined;
  private readonly runner:
    | Pick<OpenRouterDesignWorkflowRunner, "runWorkflow">
    | undefined;

  constructor(options: OpenRouterDesignProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env["OPENROUTER_API_KEY"];
    this.runner =
      options.runner ??
      (this.apiKey === undefined || this.apiKey.trim().length === 0
        ? undefined
        : new OpenRouterDesignWorkflowRunner({
            callModel: createOpenRouterChatCompletionRunner({
              apiKey: this.apiKey,
              ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
              ...(options.referer === undefined ? {} : { referer: options.referer }),
              ...(options.title === undefined ? {} : { title: options.title })
            }),
            ...(options.modelByStep === undefined
              ? {}
              : { modelByStep: options.modelByStep }),
            ...(options.maxRepairAttempts === undefined
              ? {}
              : { maxRepairAttempts: options.maxRepairAttempts })
          }));
  }

  getAuthStatus(): Promise<AgentAuthStatus> {
    if (this.runner !== undefined) {
      return Promise.resolve({
        providerId: this.id,
        state: "connected",
        message:
          "OpenRouter design workflow provider is connected through OPENROUTER_API_KEY."
      });
    }

    return Promise.resolve({
      providerId: this.id,
      state: "needs-auth",
      message:
        "Set OPENROUTER_API_KEY in the agent host environment to use OpenRouter design workflows."
    });
  }

  async startSession(request: AgentStartRequest): Promise<AgentSessionResult> {
    const sessionId = getRequestedSessionId(request) ?? randomUUID();
    const events: AgentEvent[] = [
      createMessageEvent(sessionId, "user", request.prompt)
    ];

    if (this.runner === undefined) {
      const message =
        "OpenRouter design workflow provider is not connected. Set OPENROUTER_API_KEY and restart ZeroLeaf.";
      events.push(createMessageEvent(sessionId, "assistant", message));
      return {
        sessionId,
        providerId: this.id,
        status: "failed",
        events
      };
    }

    const steps = inferRequestedDesignSteps(request.prompt);
    events.push(
      createMessageEvent(
        sessionId,
        "assistant",
        `Running ${steps.length} OpenRouter design workflow step${
          steps.length === 1 ? "" : "s"
        } with structured output validation.`
      )
    );

    try {
      const result = await this.runner.runWorkflow({
        projectName: inferProjectName(request.prompt),
        brief: request.prompt,
        steps,
        ...formatAdditionalContextPayload(request)
      });
      events.push(
        createMessageEvent(
          sessionId,
          "assistant",
          [
            `Completed OpenRouter design workflow through ${result.workflow.currentStep}.`,
            `Models used: ${result.steps
              .map((step) => `${step.stepId}=${step.model}`)
              .join(", ")}.`
          ].join("\n")
        )
      );

      return {
        sessionId,
        providerId: this.id,
        status: "completed",
        events,
        designWorkflow: result.workflow
      };
    } catch (error) {
      events.push(createMessageEvent(sessionId, "assistant", getErrorMessage(error)));
      return {
        sessionId,
        providerId: this.id,
        status: "failed",
        events
      };
    }
  }

  cancelSession(_sessionId: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}

export class OpenRouterDesignWorkflowRunner {
  private readonly callModel: OpenRouterStructuredCallRunner;
  private readonly maxRepairAttempts: number;
  private readonly modelByStep: Record<DesignWorkflowStepId, string>;

  constructor(options: OpenRouterDesignWorkflowRunnerOptions) {
    this.callModel = options.callModel;
    this.maxRepairAttempts = options.maxRepairAttempts ?? defaultRepairAttempts;
    this.modelByStep = {
      ...defaultOpenRouterDesignModels,
      ...options.modelByStep
    };
  }

  async runStep(input: OpenRouterDesignStepInput): Promise<OpenRouterDesignStepResult> {
    const model = this.modelByStep[input.stepId];
    let messages = createStepMessages(input);
    let lastValidationError = "";

    for (let attempt = 0; attempt <= this.maxRepairAttempts; attempt += 1) {
      const rawOutput = await this.callModel({
        model,
        stepId: input.stepId,
        messages,
        schema: designWorkflowOutputSchema
      });
      const workflow = parseStructuredWorkflow(rawOutput);
      const validationError = getStepWorkflowValidationError(workflow, input.stepId);

      if (validationError === undefined && workflow !== undefined) {
        return {
          stepId: input.stepId,
          model,
          attempts: attempt + 1,
          workflow
        };
      }

      lastValidationError = validationError ?? "Model did not return JSON.";
      messages = createRepairMessages(messages, lastValidationError);
    }

    throw new Error(
      `OpenRouter design step ${input.stepId} failed validation after ${
        this.maxRepairAttempts + 1
      } attempt(s): ${lastValidationError}`
    );
  }

  async runWorkflow(
    input: OpenRouterDesignWorkflowInput
  ): Promise<OpenRouterDesignWorkflowResult> {
    const stepsToRun = input.steps ?? designWorkflowStepIds;
    const results: OpenRouterDesignStepResult[] = [];
    let workflow = createEmptyDesignWorkflowOutput();

    for (const stepId of stepsToRun) {
      const result = await this.runStep({
        projectName: input.projectName,
        brief: input.brief,
        stepId,
        previousWorkflow: workflow,
        ...(input.additionalContext === undefined
          ? {}
          : { additionalContext: input.additionalContext })
      });
      workflow = mergeWorkflowStep(workflow, result.workflow, stepId);
      results.push(result);
    }

    return {
      modelByStep: this.modelByStep,
      steps: results,
      workflow
    };
  }
}

export function createOpenRouterChatCompletionRunner(
  options: OpenRouterHttpRunnerOptions
): OpenRouterStructuredCallRunner {
  return async (request) => {
    const response = await fetch(options.endpoint ?? defaultOpenRouterEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        ...(options.referer === undefined ? {} : { "HTTP-Referer": options.referer }),
        ...(options.title === undefined ? {} : { "X-Title": options.title })
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: `design_workflow_${request.stepId.replaceAll("-", "_")}`,
            strict: true,
            schema: request.schema
          }
        }
      })
    });

    if (!response.ok) {
      throw new Error(
        `OpenRouter request failed with ${response.status}: ${await response.text()}`
      );
    }

    const payload = (await response.json()) as {
      readonly choices?: readonly {
        readonly message?: {
          readonly content?: unknown;
        };
      }[];
    };
    return payload.choices?.[0]?.message?.content;
  };
}

export function getDefaultOpenRouterDesignModels(): Record<
  DesignWorkflowStepId,
  string
> {
  return { ...defaultOpenRouterDesignModels };
}

function createStepMessages(input: OpenRouterDesignStepInput): OpenRouterChatMessage[] {
  const definition = openRouterDesignWorkflowStepDefinitions[input.stepId];

  return [
    {
      role: "system",
      content: [
        "You are a website design workflow step runner.",
        "Return only JSON that matches the provided schema.",
        "The JSON must be a complete DesignWorkflowOutput.",
        `Current step id: ${input.stepId}.`,
        `Step title: ${definition.title}.`,
        `Step objective: ${definition.objective}.`,
        `Step output kind: ${definition.outputKind}.`,
        definition.prompt,
        "Return currentStep equal to the current step id.",
        "Return exactly one entry in steps for the current step.",
        "Use ready-for-review when the structured output is complete.",
        "Keep qa blocked unless this is qa-review.",
        "Keep codeGeneration not-started unless this is code-generation.",
        "Keep implementationQa not-run unless this is implementation-qa.",
        "Every step output.data must include every schema data key. Use empty strings, empty arrays, nested empty objects, or passNumber 0 for keys that do not apply."
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `Project name: ${input.projectName}`,
        `Design brief: ${input.brief}`,
        input.additionalContext === undefined
          ? ""
          : `Additional context:\n${input.additionalContext}`,
        "Previous workflow JSON:",
        JSON.stringify(input.previousWorkflow ?? createEmptyDesignWorkflowOutput())
      ]
        .filter((part) => part.length > 0)
        .join("\n\n")
    }
  ];
}

function createRepairMessages(
  messages: readonly OpenRouterChatMessage[],
  validationError: string
): OpenRouterChatMessage[] {
  return [
    ...messages,
    {
      role: "assistant",
      content: "The previous response failed local validation and cannot be accepted."
    },
    {
      role: "user",
      content: [
        "Repair the response and return only valid JSON for the same step.",
        `Validation failure: ${validationError}`,
        "Do not omit required nested structures.",
        "Do not hide required details in prose fields."
      ].join("\n")
    }
  ];
}

function parseStructuredWorkflow(value: unknown): DesignWorkflowOutput | undefined {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isValidDesignWorkflowOutput(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  return isValidDesignWorkflowOutput(value) ? value : undefined;
}

function getStepWorkflowValidationError(
  workflow: DesignWorkflowOutput | undefined,
  stepId: DesignWorkflowStepId
): string | undefined {
  if (workflow === undefined) {
    return "Output is not a valid DesignWorkflowOutput.";
  }

  if (workflow.currentStep !== stepId) {
    return `currentStep must be ${stepId}.`;
  }

  if (workflow.steps.length !== 1) {
    return "Step runner output must include exactly one step.";
  }

  if (workflow.steps[0]?.id !== stepId) {
    return `The only step must have id ${stepId}.`;
  }

  if (!isValidDesignWorkflowOutput(workflow)) {
    return "Workflow failed step-specific structured validation.";
  }

  return undefined;
}

function mergeWorkflowStep(
  previousWorkflow: DesignWorkflowOutput,
  nextWorkflow: DesignWorkflowOutput,
  stepId: DesignWorkflowStepId
): DesignWorkflowOutput {
  const nextStep = nextWorkflow.steps.find((step) => step.id === stepId);

  if (nextStep === undefined) {
    return previousWorkflow;
  }

  return {
    currentStep: stepId,
    steps: [...previousWorkflow.steps.filter((step) => step.id !== stepId), nextStep],
    qa: stepId === "qa-review" ? nextWorkflow.qa : previousWorkflow.qa,
    codeGeneration:
      stepId === "code-generation"
        ? nextWorkflow.codeGeneration
        : previousWorkflow.codeGeneration,
    implementationQa:
      stepId === "implementation-qa"
        ? nextWorkflow.implementationQa
        : previousWorkflow.implementationQa
  };
}

function inferRequestedDesignSteps(prompt: string): readonly DesignWorkflowStepId[] {
  const normalized = prompt.toLowerCase();
  const explicitStepMatch = /\bstep\s*(\d{1,2})\b/iu.exec(normalized);
  const explicitStepNumber =
    explicitStepMatch?.[1] === undefined
      ? undefined
      : Number.parseInt(explicitStepMatch[1], 10);

  if (
    explicitStepNumber !== undefined &&
    explicitStepNumber >= 1 &&
    explicitStepNumber <= designWorkflowStepIds.length
  ) {
    return [designWorkflowStepIds[explicitStepNumber - 1] as DesignWorkflowStepId];
  }

  const namedStep = designWorkflowStepIds.find((stepId) => normalized.includes(stepId));

  return namedStep === undefined ? designWorkflowStepIds : [namedStep];
}

function inferProjectName(prompt: string): string {
  const lumenMatch = /\blumen\s*&\s*loaf\b/iu.exec(prompt);

  if (lumenMatch !== null) {
    return "Lumen & Loaf";
  }

  const sampleCafeMatch = /\bcafe\b/iu.exec(prompt);

  if (sampleCafeMatch !== null) {
    return "Sample Cafe";
  }

  return "Website Design";
}

function formatAdditionalContextPayload(
  request: AgentStartRequest
): Pick<OpenRouterDesignWorkflowInput, "additionalContext"> | Record<string, never> {
  const context = [
    request.selectedText === undefined ? "" : `Selected text:\n${request.selectedText}`,
    request.activeFilePath === undefined
      ? ""
      : `Active file path: ${request.activeFilePath}`,
    request.mainFilePath === undefined ? "" : `Main file path: ${request.mainFilePath}`
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");

  return context.length === 0 ? {} : { additionalContext: context };
}

function createMessageEvent(
  sessionId: string,
  role: "user" | "assistant" | "system",
  content: string
): AgentEvent {
  return {
    id: randomUUID(),
    sessionId,
    type: "message",
    role,
    content,
    createdAt: new Date().toISOString()
  };
}

function getRequestedSessionId(request: AgentStartRequest): string | undefined {
  if (!("sessionId" in request)) {
    return undefined;
  }

  const candidate = (request as { readonly sessionId?: unknown }).sessionId;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "OpenRouter design workflow failed.";
}
