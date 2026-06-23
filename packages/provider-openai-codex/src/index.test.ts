import { describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  BuildResult,
  PdfPreviewCaptureResult
} from "@latex-agent/ipc-contracts";

import {
  CodexCliProvider,
  codexOutputSchema,
  createOpenRouterChatCompletionRunner,
  createCodexAgentEventsFromJson,
  createCodexExecArgs,
  OpenRouterDesignProvider,
  OpenRouterDesignWorkflowRunner,
  openRouterDesignWorkflowStepDefinitions,
  parseCodexLoginStatus,
  type CodexCliToolBroker,
  type OpenRouterStructuredCallRequest
} from "./index.js";
import {
  createEmptyDesignWorkflowOutput,
  isValidDesignWorkflowOutput,
  type DesignWorkflowStepId,
  type DesignWorkflowOutput
} from "./design-workflow.js";

describe("CodexCliProvider", () => {
  it("reports needs-auth when the Codex CLI is logged out", async () => {
    const provider = new CodexCliProvider({
      getCliAuthStatus: () => Promise.resolve({ loggedIn: false })
    });

    await expect(provider.getAuthStatus()).resolves.toMatchObject({
      providerId: "openai-codex",
      state: "needs-auth",
      message: "Run `codex login` in a terminal to connect Codex CLI."
    });
  });

  it("reports an error when the Codex CLI binary is missing", async () => {
    const provider = new CodexCliProvider({
      codexBinary: "/tmp/latex-agent-no-such-codex-binary"
    });

    const status = await provider.getAuthStatus();

    expect(status.providerId).toBe("openai-codex");
    expect(status.state).toBe("error");
    expect(status.message).toContain("no-such-codex-binary");
  });

  it("reports connected when the Codex CLI login is available", async () => {
    const provider = new CodexCliProvider({
      getCliAuthStatus: () => Promise.resolve({ loggedIn: true, authMethod: "ChatGPT" })
    });

    await expect(provider.getAuthStatus()).resolves.toMatchObject({
      providerId: "openai-codex",
      state: "connected",
      message: "Codex CLI is logged in using ChatGPT."
    });
  });

  it("parses Codex CLI login status output", () => {
    expect(parseCodexLoginStatus("Logged in using ChatGPT")).toEqual({
      loggedIn: true,
      authMethod: "ChatGPT"
    });
    expect(parseCodexLoginStatus("Not logged in. Run `codex login`.")).toEqual({
      loggedIn: false
    });
  });

  it("runs Codex exec with an isolated read-only planner configuration", () => {
    expect(
      createCodexExecArgs("/tmp/schema.json", "/tmp/output.json", "/tmp/project")
    ).toEqual([
      "exec",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--json",
      "--sandbox",
      "read-only",
      "-c",
      'model_reasoning_effort="low"',
      "--output-schema",
      "/tmp/schema.json",
      "--output-last-message",
      "/tmp/output.json",
      "-C",
      "/tmp/project",
      "-"
    ]);
  });

  it("can run Codex exec with writable project sandboxing", () => {
    expect(
      createCodexExecArgs(
        "/tmp/schema.json",
        "/tmp/output.json",
        "/tmp/project",
        "workspace-write"
      )
    ).toContain("workspace-write");
  });

  it("requires every top-level Codex output schema property for CLI structured output", () => {
    expect(codexOutputSchema.required).toEqual(
      Object.keys(codexOutputSchema.properties)
    );
  });

  it("defines an OpenRouter model-driven prompt for every website design step", () => {
    expect(Object.keys(openRouterDesignWorkflowStepDefinitions)).toEqual([
      "brand-story",
      "information-architecture",
      "creative-direction",
      "section-design",
      "responsive-layout",
      "interaction-motion",
      "accessibility-review",
      "qa-review",
      "code-generation",
      "implementation-qa",
      "final-polish"
    ]);
    expect(
      openRouterDesignWorkflowStepDefinitions["creative-direction"].prompt
    ).toContain("ui-ux-pro-max");
    expect(
      openRouterDesignWorkflowStepDefinitions["creative-direction"].prompt
    ).toContain("colorSystem");
    expect(openRouterDesignWorkflowStepDefinitions["section-design"].prompt).toContain(
      "layout"
    );
    expect(openRouterDesignWorkflowStepDefinitions["qa-review"].prompt).toContain(
      "qa.viewportResults"
    );
  });

  it("runs OpenRouter design steps with the configured model per step", async () => {
    const calls: OpenRouterStructuredCallRequest[] = [];
    const runner = new OpenRouterDesignWorkflowRunner({
      modelByStep: {
        "brand-story": "google/gemini-2.5-flash",
        "creative-direction": "anthropic/claude-3.5-sonnet"
      },
      callModel: (request) => {
        calls.push(request);
        return Promise.resolve(createSingleStepWorkflow(request.stepId));
      }
    });

    const result = await runner.runWorkflow({
      projectName: "Lumen & Loaf",
      brief: "A sample cafe website.",
      steps: ["brand-story", "creative-direction"]
    });

    expect(calls.map((call) => [call.stepId, call.model])).toEqual([
      ["brand-story", "google/gemini-2.5-flash"],
      ["creative-direction", "anthropic/claude-3.5-sonnet"]
    ]);
    expect(result.workflow.currentStep).toBe("creative-direction");
    expect(result.workflow.steps.map((step) => step.id)).toEqual([
      "brand-story",
      "creative-direction"
    ]);
  });

  it("runs all OpenRouter design workflow steps into one structured result", async () => {
    const runner = new OpenRouterDesignWorkflowRunner({
      callModel: (request) => Promise.resolve(createSingleStepWorkflow(request.stepId))
    });

    const result = await runner.runWorkflow({
      projectName: "Lumen & Loaf",
      brief: "Design a sample cafe website."
    });

    expect(result.steps).toHaveLength(11);
    expect(result.workflow.currentStep).toBe("final-polish");
    expect(result.workflow.steps.map((step) => step.id)).toEqual([
      "brand-story",
      "information-architecture",
      "creative-direction",
      "section-design",
      "responsive-layout",
      "interaction-motion",
      "accessibility-review",
      "qa-review",
      "code-generation",
      "implementation-qa",
      "final-polish"
    ]);
    expect(result.workflow.qa.status).toBe("pass");
    expect(result.workflow.codeGeneration.status).toBe("generated");
    expect(result.workflow.implementationQa.status).toBe("pass");
    expect(isValidDesignWorkflowOutput(result.workflow)).toBe(true);
  });

  it("includes prior workflow and ui-ux-pro-max guidance in the Step 3 OpenRouter prompt", async () => {
    let capturedRequest: OpenRouterStructuredCallRequest | undefined;
    const runner = new OpenRouterDesignWorkflowRunner({
      callModel: (request) => {
        capturedRequest = request;
        return Promise.resolve(createSingleStepWorkflow(request.stepId));
      }
    });

    await runner.runStep({
      projectName: "Lumen & Loaf",
      brief: "A sample cafe website.",
      stepId: "creative-direction",
      previousWorkflow: createSingleStepWorkflow("information-architecture")
    });

    expect(capturedRequest?.messages[0]?.content).toContain("ui-ux-pro-max");
    expect(capturedRequest?.messages[0]?.content).toContain("typographySystem");
    expect(capturedRequest?.messages[0]?.content).toContain("sectionProgression");
    expect(capturedRequest?.messages[1]?.content).toContain("Previous workflow JSON");
    expect(capturedRequest?.messages[1]?.content).toContain("information-architecture");
  });

  it("repairs invalid OpenRouter step output before accepting it", async () => {
    const calls: OpenRouterStructuredCallRequest[] = [];
    const runner = new OpenRouterDesignWorkflowRunner({
      maxRepairAttempts: 1,
      callModel: (request) => {
        calls.push(request);
        return Promise.resolve(
          calls.length === 1
            ? {
                ...createSingleStepWorkflow("brand-story"),
                currentStep: "creative-direction"
              }
            : createSingleStepWorkflow("brand-story")
        );
      }
    });

    const result = await runner.runStep({
      projectName: "Lumen & Loaf",
      brief: "A sample cafe website.",
      stepId: "brand-story"
    });

    expect(result.attempts).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.messages.at(-1)?.content).toContain("Validation failure");
  });

  it("sends OpenRouter chat completions with strict JSON schema output", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(
      () =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              choices: [{ message: { content: '{"currentStep":"none"}' } }]
            })
        } as Response)
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const callOpenRouter = createOpenRouterChatCompletionRunner({
        apiKey: "test-key",
        endpoint: "https://openrouter.test/api/v1/chat/completions",
        referer: "https://zeroleaf.test",
        title: "ZeroLeaf"
      });

      await callOpenRouter({
        model: "google/gemini-2.5-flash",
        stepId: "brand-story",
        messages: [{ role: "user", content: "Return JSON." }],
        schema: codexOutputSchema.properties.designWorkflow
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://openrouter.test/api/v1/chat/completions",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test-key",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://zeroleaf.test",
            "X-Title": "ZeroLeaf"
          })
        })
      );
      const fetchCalls = fetchMock.mock.calls;
      const body = JSON.parse(fetchCalls[0]?.[1].body as string) as {
        readonly response_format: {
          readonly type: string;
          readonly json_schema: { readonly strict: boolean };
        };
      };
      expect(body.response_format).toMatchObject({
        type: "json_schema",
        json_schema: { strict: true }
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports OpenRouter design provider needs-auth without an API key", async () => {
    const provider = new OpenRouterDesignProvider({ apiKey: "" });

    await expect(provider.getAuthStatus()).resolves.toMatchObject({
      providerId: "openrouter-design",
      state: "needs-auth",
      message: expect.stringContaining("OPENROUTER_API_KEY")
    });
  });

  it("runs OpenRouter design provider sessions through structured workflow output", async () => {
    const provider = new OpenRouterDesignProvider({
      runner: {
        runWorkflow: (input) => {
          const steps = input.steps ?? ["brand-story"];
          return Promise.resolve({
            modelByStep: {
              ...Object.fromEntries(
                [
                  "brand-story",
                  "information-architecture",
                  "creative-direction",
                  "section-design",
                  "responsive-layout",
                  "interaction-motion",
                  "accessibility-review",
                  "qa-review",
                  "code-generation",
                  "implementation-qa",
                  "final-polish"
                ].map((stepId) => [stepId, "google/gemini-2.5-flash"])
              )
            } as Record<DesignWorkflowStepId, string>,
            steps: steps.map((stepId) => ({
              stepId,
              model: "google/gemini-2.5-flash",
              attempts: 1,
              workflow: createSingleStepWorkflow(stepId)
            })),
            workflow: createSingleStepWorkflow(steps[0] ?? "brand-story")
          });
        }
      }
    });

    const result = await provider.startSession({
      providerId: "openrouter-design",
      mode: "suggest",
      projectRoot: "/tmp/project",
      sessionId: "openrouter-design-test",
      prompt: "Run step 3 for the Lumen & Loaf cafe website.",
      compiler: "pdflatex"
    });

    expect(result.status).toBe("completed");
    expect(result.providerId).toBe("openrouter-design");
    expect(result.designWorkflow).toMatchObject({
      currentStep: "creative-direction"
    });
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.role === "assistant" &&
          event.content.includes("Models used")
      )
    ).toBe(true);
  });

  it("includes a structured website design workflow and QA loop in Codex output schema", () => {
    expect(codexOutputSchema.properties.designWorkflow).toMatchObject({
      type: "object",
      required: ["currentStep", "steps", "qa", "codeGeneration", "implementationQa"]
    });
    expect(
      codexOutputSchema.properties.designWorkflow.properties.steps.items.properties
        .output.properties.data
    ).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: expect.objectContaining({
        brandName: { type: "string" },
        businessType: { type: "string" },
        websiteStoryArc: expect.objectContaining({ type: "array" }),
        sectionsDetailed: expect.objectContaining({ type: "array" }),
        primaryUserPaths: expect.objectContaining({ type: "array" }),
        ctaPriority: expect.objectContaining({ type: "array" }),
        navigationModel: expect.objectContaining({
          type: "object",
          additionalProperties: false
        }),
        handoffToCreativeDirection: expect.objectContaining({
          type: "object",
          additionalProperties: false
        }),
        colorSystem: expect.objectContaining({ type: "array" }),
        typographySystem: expect.objectContaining({
          type: "object",
          additionalProperties: false
        }),
        imageDirection: expect.objectContaining({
          type: "object",
          additionalProperties: false
        }),
        ctaSystem: expect.objectContaining({
          type: "object",
          additionalProperties: false
        }),
        motionMood: expect.objectContaining({
          type: "object",
          additionalProperties: false
        }),
        sectionProgression: expect.objectContaining({ type: "array" }),
        handoffToSectionDesign: expect.objectContaining({
          type: "object",
          additionalProperties: false
        }),
        toneOfVoice: expect.objectContaining({
          type: "object",
          additionalProperties: false
        })
      }),
      required: expect.arrayContaining([
        "brandName",
        "businessType",
        "toneOfVoice",
        "websiteStoryArc",
        "sectionsDetailed",
        "primaryUserPaths",
        "ctaPriority",
        "navigationModel",
        "handoffToCreativeDirection",
        "colorSystem",
        "typographySystem",
        "imageDirection",
        "compositionPrinciples",
        "spacingRhythm",
        "textureMaterialRules",
        "iconIllustrationRules",
        "ctaSystem",
        "motionMood",
        "sectionProgression",
        "handoffToSectionDesign"
      ])
    });
    expect(codexOutputSchema.properties.designWorkflow.properties.qa).toMatchObject({
      type: "object",
      required: [
        "passNumber",
        "status",
        "inspectedAt",
        "scope",
        "viewportResults",
        "issues",
        "fixPlan",
        "resolvedIssueIds",
        "remainingIssueIds",
        "stopCondition",
        "nextAction"
      ]
    });
    expect(
      codexOutputSchema.properties.designWorkflow.properties.codeGeneration
    ).toMatchObject({
      type: "object",
      required: [
        "status",
        "summary",
        "targetFiles",
        "components",
        "assets",
        "constraints",
        "implementationNotes",
        "acceptanceCriteria"
      ]
    });
    expect(
      codexOutputSchema.properties.designWorkflow.properties.implementationQa
    ).toMatchObject({
      type: "object",
      required: [
        "passNumber",
        "status",
        "inspectedAt",
        "scope",
        "checks",
        "issues",
        "fixPlan",
        "resolvedIssueIds",
        "remainingIssueIds",
        "stopCondition",
        "nextAction"
      ]
    });
  });

  it("validates empty and populated design QA workflow payloads", () => {
    expect(isValidDesignWorkflowOutput(createEmptyDesignWorkflowOutput())).toBe(true);
    expect(
      isValidDesignWorkflowOutput({
        currentStep: "qa-review",
        steps: [
          {
            id: "section-design",
            title: "Hero section",
            status: "needs-revision",
            objective: "Make the cafe hero specific and readable.",
            output: {
              kind: "section-spec",
              summary: "Image-led cafe hero with two CTAs.",
              data: createCafeSectionDesignData()
            }
          }
        ],
        qa: {
          passNumber: 1,
          status: "needs-revision",
          inspectedAt: "2026-06-22T18:00:00.000Z",
          scope: "Lumen & Loaf hero section",
          viewportResults: [
            {
              viewport: "mobile",
              status: "issues-found",
              evidence: "Mobile screenshot shows CTA wrapping into two cramped rows.",
              notes: "Primary and secondary actions need a stacked layout."
            }
          ],
          issues: [
            {
              id: "QA-001",
              category: "brand-story",
              severity: "medium",
              location: "hero copy",
              problem: "The subheadline could belong to any cafe.",
              evidenceKind: "manual-inspection",
              evidence: "Copy says only fresh coffee and pastries.",
              recommendedFix:
                "Replace generic copy with a specific morning ritual detail.",
              status: "open"
            }
          ],
          fixPlan: [
            {
              id: "FIX-001",
              issueIds: ["QA-001"],
              action: "revise-copy",
              targetSection: "hero",
              description:
                "Add sensory details about window seats and bread from the oven.",
              expectedOutcome: "The hero sounds specific to Lumen & Loaf.",
              requiresPatch: true
            }
          ],
          resolvedIssueIds: [],
          remainingIssueIds: ["QA-001"],
          stopCondition: "Continue until all high and medium issues are resolved.",
          nextAction: "apply-fixes"
        },
        codeGeneration: {
          status: "ready-for-review",
          summary: "Implement the approved cafe hero section.",
          targetFiles: ["src/App.tsx", "src/styles.css"],
          components: ["CafeHero"],
          assets: ["sunlit-cafe-table.webp"],
          constraints: [
            "light-only",
            "no dark panels",
            "text over image must keep accessible contrast"
          ],
          implementationNotes: [
            "Use a full-bleed image hero and stack CTAs on mobile."
          ],
          acceptanceCriteria: [
            "Hero copy is specific to Lumen & Loaf.",
            "No horizontal scroll at mobile width."
          ]
        },
        implementationQa: {
          passNumber: 1,
          status: "needs-revision",
          inspectedAt: "2026-06-22T18:05:00.000Z",
          scope: "Rendered Lumen & Loaf hero implementation",
          checks: [
            {
              id: "CHECK-001",
              kind: "responsive",
              status: "issues-found",
              target: "375x812 hero",
              evidence: "Rendered mobile screenshot shows CTA crowding.",
              notes: "Stack buttons and increase vertical gap."
            }
          ],
          issues: [
            {
              id: "IQA-001",
              category: "responsive",
              severity: "high",
              location: "hero CTAs",
              problem: "CTA buttons collide on narrow mobile.",
              evidenceKind: "screenshot",
              evidence: "375x812 rendered screenshot",
              recommendedFix: "Stack CTAs and reserve stable button height.",
              status: "open"
            }
          ],
          fixPlan: [
            {
              id: "IFIX-001",
              issueIds: ["IQA-001"],
              action: "adjust-responsive-rules",
              targetSection: "hero",
              description: "Stack the CTA group below 640px.",
              expectedOutcome: "Buttons remain tappable and readable.",
              requiresPatch: true
            }
          ],
          resolvedIssueIds: [],
          remainingIssueIds: ["IQA-001"],
          stopCondition:
            "Continue until rendered layout passes all required viewport checks.",
          nextAction: "apply-fixes"
        }
      })
    ).toBe(true);
  });

  it("rejects brand-story steps with empty structured data", () => {
    expect(
      isValidDesignWorkflowOutput({
        ...createEmptyDesignWorkflowOutput(),
        currentStep: "brand-story",
        steps: [
          {
            id: "brand-story",
            title: "Brand Story",
            status: "ready-for-review",
            objective: "Define the cafe identity.",
            output: {
              kind: "brief",
              summary: "Lumen & Loaf is a warm neighborhood cafe.",
              data: {}
            }
          }
        ]
      })
    ).toBe(false);
  });

  it("rejects information-architecture steps that hide details in prose", () => {
    expect(
      isValidDesignWorkflowOutput({
        ...createEmptyDesignWorkflowOutput(),
        currentStep: "information-architecture",
        steps: [
          {
            id: "information-architecture",
            title: "Information Architecture",
            status: "ready-for-review",
            objective: "Define the site structure.",
            output: {
              kind: "sitemap",
              summary: "Single-page cafe website IA.",
              data: {
                ...createEmptyWorkflowStepData(),
                sections: ["hero", "menu", "visit"],
                section:
                  "Navigation, user paths, CTA priority, and handoff notes are all described here as prose instead of structured fields."
              }
            }
          }
        ]
      })
    ).toBe(false);
  });

  it("rejects information-architecture steps with dangling section references", () => {
    expect(
      isValidDesignWorkflowOutput({
        ...createEmptyDesignWorkflowOutput(),
        currentStep: "information-architecture",
        steps: [
          {
            id: "information-architecture",
            title: "Information Architecture",
            status: "ready-for-review",
            objective: "Define the site structure.",
            output: {
              kind: "sitemap",
              summary: "Single-page cafe website IA.",
              data: {
                ...createCafeInformationArchitectureData(),
                sectionOrder: ["hero", "daily-counter", "missing-section"]
              }
            }
          }
        ]
      })
    ).toBe(false);
  });

  it("accepts information-architecture steps with consistent section references", () => {
    expect(
      isValidDesignWorkflowOutput({
        ...createEmptyDesignWorkflowOutput(),
        currentStep: "information-architecture",
        steps: [
          {
            id: "information-architecture",
            title: "Information Architecture",
            status: "ready-for-review",
            objective: "Define the site structure.",
            output: {
              kind: "sitemap",
              summary: "Single-page cafe website IA.",
              data: createCafeInformationArchitectureData()
            }
          }
        ]
      })
    ).toBe(true);
  });

  it("rejects creative-direction steps that hide the visual system in generic prose", () => {
    expect(
      isValidDesignWorkflowOutput({
        ...createEmptyDesignWorkflowOutput(),
        currentStep: "creative-direction",
        steps: [
          {
            id: "creative-direction",
            title: "Creative Direction",
            status: "ready-for-review",
            objective: "Define the cafe visual system.",
            output: {
              kind: "style-system",
              summary: "Warm, sunlit, literary cafe direction.",
              data: {
                ...createEmptyWorkflowStepData(),
                palette: ["warm ivory", "loaf crust", "coffee ink"],
                photography:
                  "Use bright natural-light cafe photography with bread and cups.",
                contentRequirements: [
                  "Typography, spacing, motion, CTAs, and section progression are described here as prose instead of structured fields."
                ]
              }
            }
          }
        ]
      })
    ).toBe(false);
  });

  it("accepts creative-direction steps with a structured visual system", () => {
    expect(
      isValidDesignWorkflowOutput({
        ...createEmptyDesignWorkflowOutput(),
        currentStep: "creative-direction",
        steps: [
          {
            id: "creative-direction",
            title: "Creative Direction",
            status: "ready-for-review",
            objective: "Define the cafe visual system.",
            output: {
              kind: "style-system",
              summary: "Light-only editorial cafe direction.",
              data: createCafeCreativeDirectionData()
            }
          }
        ]
      })
    ).toBe(true);
  });

  it.each([
    ["section-design", "sectionDesigns", createCafeSectionDesignData],
    ["responsive-layout", "responsiveRules", createCafeResponsiveLayoutData],
    ["interaction-motion", "interactionRules", createCafeInteractionMotionData],
    ["accessibility-review", "accessibilityChecks", createCafeAccessibilityReviewData],
    ["final-polish", "polishChecks", createCafeFinalPolishData]
  ] as const)(
    "rejects %s steps that hide required structure outside %s",
    (stepId, requiredKey, createValidData) => {
      expect(
        isValidDesignWorkflowOutput({
          ...createEmptyDesignWorkflowOutput(),
          currentStep: stepId,
          steps: [
            {
              id: stepId,
              title: openRouterDesignWorkflowStepDefinitions[stepId].title,
              status: "ready-for-review",
              objective: openRouterDesignWorkflowStepDefinitions[stepId].objective,
              output: {
                kind: createSingleStepWorkflow(stepId).steps[0]?.output.kind ?? "none",
                summary: "The required details are described in prose.",
                data: {
                  ...createEmptyWorkflowStepData(),
                  contentRequirements: [
                    `This prose mentions ${requiredKey} but does not populate the structured field.`
                  ]
                }
              }
            }
          ]
        })
      ).toBe(false);

      expect(
        isValidDesignWorkflowOutput({
          ...createEmptyDesignWorkflowOutput(),
          currentStep: stepId,
          steps: [
            {
              id: stepId,
              title: openRouterDesignWorkflowStepDefinitions[stepId].title,
              status: "ready-for-review",
              objective: openRouterDesignWorkflowStepDefinitions[stepId].objective,
              output: {
                kind: createSingleStepWorkflow(stepId).steps[0]?.output.kind ?? "none",
                summary: "Structured step output.",
                data: createValidData()
              }
            }
          ]
        })
      ).toBe(true);
    }
  );

  it.each([
    ["qa-review", "qa"],
    ["code-generation", "codeGeneration"],
    ["implementation-qa", "implementationQa"]
  ] as const)(
    "rejects %s steps when the %s payload is still empty",
    (stepId, _payloadKey) => {
      expect(
        isValidDesignWorkflowOutput({
          ...createEmptyDesignWorkflowOutput(),
          currentStep: stepId,
          steps: [
            {
              id: stepId,
              title: openRouterDesignWorkflowStepDefinitions[stepId].title,
              status: "ready-for-review",
              objective: openRouterDesignWorkflowStepDefinitions[stepId].objective,
              output: {
                kind: createSingleStepWorkflow(stepId).steps[0]?.output.kind ?? "none",
                summary: "The stage step is present but its payload is empty.",
                data: createEmptyWorkflowStepData()
              }
            }
          ]
        })
      ).toBe(false);
    }
  );

  it("ignores public Codex JSONL command events in the persisted transcript", () => {
    expect(
      createCodexAgentEventsFromJson(
        {
          type: "exec_command_begin",
          command: "rg author summary_of_changes.tex"
        },
        "session-1"
      )
    ).toEqual([]);
  });

  it("maps public Codex assistant text while ignoring structured final JSON", () => {
    expect(
      createCodexAgentEventsFromJson(
        {
          type: "agent_message",
          message: "I found the file and am preparing the edit."
        },
        "session-1"
      )
    ).toEqual([
      expect.objectContaining({
        type: "message",
        role: "assistant",
        content: "I found the file and am preparing the edit."
      })
    ]);
    expect(
      createCodexAgentEventsFromJson(
        {
          type: "agent_message",
          message:
            '{"action":"answer","targetFilePath":"main.tex","summary":"","afterContents":"","message":"","notes":""}'
        },
        "session-1"
      )
    ).toEqual([]);
  });

  it("ignores Codex reasoning JSONL events", () => {
    expect(
      createCodexAgentEventsFromJson(
        {
          type: "agent_reasoning",
          text: "private scratchpad"
        },
        "session-1"
      )
    ).toEqual([]);
  });

  it("runs read-only tasks through Codex exec and returns the model answer", async () => {
    const calls: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: () =>
        Promise.resolve(
          createCodexAnswer("The active file is a short article with one warning.")
        )
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt: "Summarize the active file",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        diagnostic: {
          severity: "warning",
          filePath: "main.tex",
          line: 3,
          message: "Citation `knuth1984` undefined"
        }
      },
      createBroker(calls)
    );

    expect(result.status).toBe("completed");
    expect(result.changeset).toBeUndefined();
    expect(calls).toEqual(["read-file:main.tex"]);
    expect(
      result.events.some(
        (event) => event.type === "tool-call" && event.toolName === "read-file"
      )
    ).toBe(true);
    expect(
      result.events.some(
        (event) => event.type === "tool-call" && event.toolName === "codex-exec"
      )
    ).toBe(true);
    expect(result.events.some((event) => event.type === "patch")).toBe(false);
    expect(result.events.some((event) => event.type === "approval")).toBe(false);
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.content.includes("The active file is a short article")
      )
    ).toBe(true);
  });

  it("turns Codex Word edit output into a reviewable Word changeset", async () => {
    const calls: string[] = [];
    let providerPrompt = "";
    const wordBlocks = [
      { id: "w1", kind: "paragraph" as const, text: "Old abstract text." },
      { id: "w2", kind: "paragraph" as const, text: "Keep this paragraph." }
    ];
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        providerPrompt = request.prompt;
        return Promise.resolve({
          action: "word-edit",
          targetFilePath: "proposal.docx",
          summary: "Rewrite abstract",
          afterContents: "",
          patches: [],
          wordChangesets: [
            {
              filePath: "proposal.docx",
              summary: "Rewrite abstract",
              operations: [
                {
                  type: "replace-block",
                  blockId: "w1",
                  afterText: "Clearer abstract text."
                }
              ]
            }
          ],
          message: "I prepared a Word changeset.",
          notes: "Generated by fake Codex runner"
        });
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Rewrite the abstract in the Word document.",
        activeFilePath: "proposal.docx",
        activeDocument: {
          kind: "word",
          path: "proposal.docx",
          plainText: "Old abstract text.\n\nKeep this paragraph.",
          blocks: wordBlocks,
          warnings: []
        },
        compiler: "pdflatex"
      },
      createBroker(calls)
    );

    expect(result.status).toBe("completed");
    expect(result.changeset).toBeUndefined();
    expect(result.wordChangeset).toMatchObject({
      projectRoot: "/tmp/project",
      filePath: "proposal.docx",
      summary: "Rewrite abstract",
      baseBlocks: wordBlocks,
      operations: [
        {
          type: "replace-block",
          blockId: "w1",
          afterText: "Clearer abstract text."
        }
      ],
      status: "proposed"
    });
    expect(result.wordChangesets).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(result.events.some((event) => event.type === "patch")).toBe(true);
    expect(result.events.some((event) => event.type === "approval")).toBe(false);
    expect(providerPrompt).toContain("Microsoft Word .docx");
    expect(providerPrompt).toContain('set action "word-edit"');
    expect(providerPrompt).toContain("populate wordChangesets");
  });

  it("captures the PDF preview and asks Codex for screenshot-backed assessment", async () => {
    const calls: string[] = [];
    const prompts: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        prompts.push(request.prompt);

        if (prompts.length === 1) {
          return Promise.resolve({
            action: "capture-pdf-preview",
            targetFilePath: "",
            summary: "Need rendered preview evidence",
            afterContents: "",
            message: "I need to inspect the rendered PDF preview.",
            notes: "Requested PDF preview capture"
          });
        }

        return Promise.resolve(
          createCodexAnswer("The captured PDF preview shows no visible clipping.")
        );
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt:
          "Take a screenshot of the PDF preview and assess whether it is clipped.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls)
    );

    expect(result.status).toBe("completed");
    expect(calls).toEqual(["read-file:main.tex", "capture-pdf-preview"]);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('Set action to "capture-pdf-preview"');
    expect(prompts[1]).toContain("Rendered PDF preview evidence:");
    expect(prompts[1]).toContain(
      "Screenshot path: /tmp/project/.latex-agent/visual-captures/pdf-preview.png"
    );
    expect(prompts[1]).toContain("Preview page: 1 / 2");
    expect(
      result.events.some(
        (event) =>
          event.type === "tool-call" &&
          event.toolName === "capture-pdf-preview" &&
          event.status === "succeeded"
      )
    ).toBe(true);
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.role === "assistant" &&
          event.content.includes("no visible clipping")
      )
    ).toBe(true);
  });

  it("emits Codex CLI heartbeat events during long planner runs", async () => {
    const emittedEvents: AgentEvent[] = [];
    const provider = new CodexCliProvider({
      progressHeartbeatMs: 5,
      runCodexExec: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return createCodexAnswer("The project has one active source file.");
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt: "Summarize the active file",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker([], { emittedEvents })
    );

    expect(result.status).toBe("completed");
    expect(
      emittedEvents.some(
        (event) =>
          event.type === "tool-call" &&
          event.toolName === "codex-exec" &&
          event.status === "running" &&
          event.summary.includes("Codex CLI is still analyzing")
      )
    ).toBe(true);
  });

  it("delegates thesis summaries in read-only mode to Codex", async () => {
    const calls: string[] = [];
    let providerPrompt = "";
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        providerPrompt = request.prompt;
        return Promise.resolve(
          createCodexAnswer(
            "Structure: Introduction, Method, Conclusion.\n\nBuild health: not verified by this answer."
          )
        );
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt:
          "Summarize this thesis project structure, main claims, missing sections, and build health.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls, {
        readFiles: {
          "main.tex": [
            "\\documentclass{report}",
            "\\begin{document}",
            "\\chapter{Introduction}",
            "We demonstrate that local-first editing improves review.",
            "\\input{chapters/method}",
            "\\input{chapters/conclusion}",
            "\\end{document}",
            ""
          ].join("\n"),
          "chapters/method.tex":
            "\\chapter{Method}\nOur contributions are a scoped agent workflow.",
          "chapters/conclusion.tex":
            "\\chapter{Conclusion}\nThis thesis argues for reviewable patches."
        }
      })
    );

    expect(result.status).toBe("completed");
    expect(calls).toEqual(["read-file:main.tex"]);
    expect(providerPrompt).toContain("Use your own judgment");
    expect(providerPrompt).toContain('Set action to "answer"');
    expect(
      result.events.some(
        (event) => event.type === "message" && event.content.includes("Structure:")
      )
    ).toBe(true);
    expect(
      result.events.some(
        (event) => event.type === "message" && event.content.includes("Build health:")
      )
    ).toBe(true);
  });

  it("delegates final formatting review prompts to Codex", async () => {
    const calls: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: () =>
        Promise.resolve(
          createCodexAnswer("Priority 1 blockers: Missing local figure asset.")
        )
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt: [
          "Final PDF formatting review before submission.",
          "- warning: Generated build artifact is present in the source tree. (.latex-agent/build/main.log)"
        ].join("\n"),
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls, {
        readFiles: {
          "main.tex": [
            "\\documentclass{article}",
            "\\usepackage{graphicx}",
            "\\begin{document}",
            "\\begin{figure}[ht]",
            "\\includegraphics{figures/missing.png}",
            "\\caption{System overview}",
            "\\end{figure}",
            "\\end{document}",
            ""
          ].join("\n")
        }
      })
    );

    expect(result.status).toBe("completed");
    expect(calls).toEqual(["read-file:main.tex"]);
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.content.includes("Priority 1 blockers:") &&
          event.content.includes("Missing local figure asset")
      )
    ).toBe(true);
    expect(
      result.events.some(
        (event) => event.type === "tool-call" && event.toolName === "codex-exec"
      )
    ).toBe(true);
  });

  it("asks Codex for structured section-by-section website QA output", async () => {
    let providerPrompt = "";
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        providerPrompt = request.prompt;
        return Promise.resolve(
          createCodexAnswer("QA pass 1 found hero storytelling and mobile CTA issues.")
        );
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt:
          "Review the sample cafe website hero section and return QA defects plus a fix loop.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker()
    );

    expect(result.status).toBe("completed");
    expect(providerPrompt).toContain("The schema always requires designWorkflow");
    expect(providerPrompt).toContain("brand-story");
    expect(providerPrompt).toContain("section-design");
    expect(providerPrompt).toContain("qa-review");
    expect(providerPrompt).toContain("code-generation");
    expect(providerPrompt).toContain("implementation-qa");
    expect(providerPrompt).toContain("output.data must not be empty");
    expect(providerPrompt).toContain("brandName");
    expect(providerPrompt).toContain("toneOfVoice");
    expect(providerPrompt).toContain("must not hide IA details in prose");
    expect(providerPrompt).toContain("websiteStoryArc");
    expect(providerPrompt).toContain("sectionsDetailed");
    expect(providerPrompt).toContain("primaryUserPaths");
    expect(providerPrompt).toContain("ctaPriority");
    expect(providerPrompt).toContain("navigationModel");
    expect(providerPrompt).toContain("handoffToCreativeDirection");
    expect(providerPrompt).toContain("must not hide the visual system");
    expect(providerPrompt).toContain("colorSystem");
    expect(providerPrompt).toContain("typographySystem");
    expect(providerPrompt).toContain("imageDirection");
    expect(providerPrompt).toContain("spacingRhythm");
    expect(providerPrompt).toContain("ctaSystem");
    expect(providerPrompt).toContain("motionMood");
    expect(providerPrompt).toContain("sectionProgression");
    expect(providerPrompt).toContain("handoffToSectionDesign");
    expect(providerPrompt).toContain("sectionDesigns");
    expect(providerPrompt).toContain("responsiveRules");
    expect(providerPrompt).toContain("interactionRules");
    expect(providerPrompt).toContain("accessibilityChecks");
    expect(providerPrompt).toContain("polishChecks");
    expect(providerPrompt).toContain("codeGeneration");
    expect(providerPrompt).toContain("implementationQa");
    expect(providerPrompt).toContain("visual-layout");
    expect(providerPrompt).toContain("brand-story");
    expect(providerPrompt).toContain("viewportResults for mobile, tablet, desktop");
    expect(providerPrompt).toContain("fixPlan");
    expect(providerPrompt).toContain("must not claim success without evidence");
    expect(providerPrompt).toContain("must not claim success without rendered");
  });

  it("runs the sample cafe website workflow through the provider result path", async () => {
    const calls: string[] = [];
    const workflow = createCafeWebsiteWorkflow();
    const provider = new CodexCliProvider({
      runCodexExec: () =>
        Promise.resolve({
          ...createCodexAnswer(
            "Completed the sample cafe workflow through final polish."
          ),
          summary: "Run cafe website design workflow",
          designWorkflow: workflow,
          notes: "Returned full structured workflow from fake Codex runner"
        })
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "read-only",
        projectRoot: "/tmp/project",
        prompt:
          "Run all website design workflow steps for the sample cafe Lumen & Loaf.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls)
    );

    expect(result.status).toBe("completed");
    expect(calls).toEqual(["read-file:main.tex"]);
    expect(result.designWorkflow).toEqual(workflow);
    expect(isValidDesignWorkflowOutput(result.designWorkflow)).toBe(true);
    expect(
      (result.designWorkflow as DesignWorkflowOutput).steps.map((step) => step.id)
    ).toEqual([
      "brand-story",
      "information-architecture",
      "creative-direction",
      "section-design",
      "responsive-layout",
      "interaction-motion",
      "accessibility-review",
      "qa-review",
      "code-generation",
      "implementation-qa",
      "final-polish"
    ]);
    expect((result.designWorkflow as DesignWorkflowOutput).codeGeneration.status).toBe(
      "generated"
    );
    expect(
      (result.designWorkflow as DesignWorkflowOutput).implementationQa.status
    ).toBe("pass");
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.role === "assistant" &&
          event.content.includes("Completed the sample cafe workflow")
      )
    ).toBe(true);
  });

  it("lets Codex answer autonomous no-edit questions without proposing patches", async () => {
    const calls: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: () =>
        Promise.resolve(
          createCodexAnswer(
            "The paper studies autonomous vehicle perception under covert spoofing."
          )
        )
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "autonomous-local",
        projectRoot: "/tmp/project",
        prompt: "What is this TSMC paper about?",
        activeFilePath: "IEEE_TSMC.tex",
        mainFilePath: "IEEE_TSMC.tex",
        compiler: "pdflatex"
      },
      createBroker(calls, {
        readFiles: {
          "IEEE_TSMC.tex": [
            "\\documentclass{IEEEtran}",
            "\\begin{document}",
            "\\title{Vision-Aligned Video Diffusion and Doppler-Consistent GNSS Spoofing}",
            "\\begin{abstract}",
            "This paper studies autonomous vehicle perception under covert spoofing.",
            "\\end{abstract}",
            "\\section{Introduction}",
            "The manuscript proposes a hybrid attack and evaluates detection.",
            "\\end{document}",
            ""
          ].join("\n")
        }
      })
    );

    expect(result.status).toBe("completed");
    expect(result.changeset).toBeUndefined();
    expect(calls).toEqual(["read-file:IEEE_TSMC.tex"]);
    expect(
      result.events.some(
        (event) => event.type === "tool-call" && event.toolName === "codex-exec"
      )
    ).toBe(true);
    expect(result.events.some((event) => event.type === "approval")).toBe(false);
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.content.includes("autonomous vehicle perception")
      )
    ).toBe(true);
  });

  it("answers literature-review planning requests that cite a PDF without retrying into an action", async () => {
    const calls: string[] = [];
    const prompts: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        prompts.push(request.prompt);
        return Promise.resolve(
          createCodexAnswer(
            "Here is a thesis-based literature review plan organized by themes, evidence gaps, and section order."
          )
        );
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt:
          "prepare a plan for literature review of the paper based on thesis pdf file",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls)
    );

    expect(result.status).toBe("completed");
    expect(result.changeset).toBeUndefined();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Use action "answer" for planning');
    expect(prompts[0]).toContain(
      "A user mentioning a PDF, paper, thesis, manuscript, or active document as source context does not by itself require a file edit"
    );
    expect(calls).toEqual(["read-file:main.tex"]);
    expect(result.events.some((event) => event.type === "patch")).toBe(false);
    expect(result.events.some((event) => event.type === "approval")).toBe(false);
    expect(
      result.events.some(
        (event) => event.type === "tool-call" && event.toolName === "run-compile"
      )
    ).toBe(false);
    expect(
      result.events.some(
        (event) =>
          event.type === "message" && event.content.includes("literature review plan")
      )
    ).toBe(true);
  });

  it("retries section-merge requests into a concrete source edit", async () => {
    const calls: string[] = [];
    const prompts: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        prompts.push(request.prompt);

        if (prompts.length === 1) {
          return Promise.resolve(
            createCodexAnswer(
              "Sections 2.1 through 2.7 should be consolidated into three subsections."
            )
          );
        }

        return Promise.resolve({
          action: "patch",
          targetFilePath: "main.tex",
          summary: "Merge literature review subsections",
          afterContents:
            "\\documentclass{article}\n\\begin{document}\n\\section{Literature Review}\n\\subsection{Theme One}\nMerged content.\n\\subsection{Theme Two}\nMerged content.\n\\subsection{Theme Three}\nMerged content.\n\\end{document}\n",
          message:
            "I merged Literature Review subsections 2.1 through 2.7 into three thematic subsections in `main.tex`.",
          notes: "Retry produced source edit"
        });
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt:
          "from 2.1 to 2.7 sub section of literature review, we should merge them to only have 3 sub sections",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls)
    );

    expect(result.status).toBe("awaiting-approval");
    expect(result.changeset?.summary).toBe("Merge literature review subsections");
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("Requests to merge, combine, consolidate");
    expect(prompts[0]).toContain("In message, always explain the result");
    expect(prompts[1]).toContain("Retry instruction:");
    expect(calls).toEqual(["read-file:main.tex", "propose-patch"]);
    expect(
      result.events.some(
        (event) =>
          event.type === "patch" &&
          event.summary === "Merge literature review subsections"
      )
    ).toBe(true);
  });

  it("runs autonomous Codex sessions with direct project write access", async () => {
    const calls: string[] = [];
    let providerPrompt = "";
    let sandboxMode = "";
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        providerPrompt = request.prompt;
        sandboxMode = request.sandboxMode ?? "";
        return Promise.resolve({
          action: "run-compile",
          targetFilePath: "main.tex",
          summary: "Moved references into references.bib",
          afterContents: "",
          patches: [],
          message: "I moved the references into a separate bibliography file.",
          notes: "Edited files directly in Codex CLI"
        });
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "autonomous-local",
        projectRoot: "/tmp/project",
        prompt: "move references from source main.tex to a separate file",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls, {
        compileResults: [
          createBuildResult({
            jobId: "build-direct-edit",
            status: "succeeded"
          })
        ],
        readFiles: {
          "main.tex": "\\documentclass{article}\n\\begin{document}\nHello\n"
        }
      })
    );

    expect(sandboxMode).toBe("workspace-write");
    expect(providerPrompt).toContain("modify files directly");
    expect(providerPrompt).toContain("Do not write outside the project root");
    expect(providerPrompt).toContain('return action "run-compile"');
    expect(result.status).toBe("completed");
    expect(result.changeset).toBeUndefined();
    expect(result.buildResult?.status).toBe("succeeded");
    expect(calls).toEqual(["read-file:main.tex", "run-compile"]);
  });

  it("turns installed-Codex output into a reviewable changeset", async () => {
    let providerPrompt = "";
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        providerPrompt = request.prompt;
        return Promise.resolve({
          action: "patch",
          targetFilePath: "main.tex",
          summary: "Add document end",
          afterContents:
            "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n",
          message: "I prepared a minimal patch.",
          notes: "Generated by fake Codex runner"
        });
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Fix the compile error",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        selectedText:
          "This is a bit rough, but we show that results follow \\citep{smith2024}."
      },
      createBroker()
    );

    expect(result.status).toBe("awaiting-approval");
    expect(result.changeset?.summary).toBe("Add document end");
    expect(result.events.some((event) => event.type === "approval")).toBe(true);
    expect(
      result.events.some(
        (event) => event.type === "tool-call" && event.toolName === "codex-exec"
      )
    ).toBe(true);
    expect(providerPrompt).toContain("Change only that exact selected span");
    expect(providerPrompt).toContain("preserve all unrelated paragraphs");
    expect(providerPrompt).toContain("labels, references, and citations");
    expect(providerPrompt).toContain("do not add new claims or citations");
    expect(providerPrompt).toContain("preserve TODO lines that require user input");
    expect(providerPrompt).toContain("preserve required contribution statements");
    expect(providerPrompt).toContain("make the smallest syntax-only edit");
    expect(providerPrompt).toContain("balance the caption braces without rewriting");
    expect(providerPrompt).toContain(
      "produce valid LaTeX using the project's existing table conventions"
    );
    expect(providerPrompt).toContain("mention width/layout advice in notes");
    expect(providerPrompt).toContain("preserve citation keys, labels, file paths");
    expect(providerPrompt).toContain('Set action to "patch" when');
    expect(providerPrompt).toContain(
      'return the concrete action whenever safe: "patch" for source edits'
    );
    expect(providerPrompt).toContain('"delete-entry" for deleting project files');
    expect(providerPrompt).toContain('"move-entry" for moving or renaming files');
    expect(providerPrompt).toContain(
      '"set-main-file" for changing the project main TeX file'
    );
    expect(providerPrompt).toContain('"run-compile" for builds');
    expect(providerPrompt).toContain("\\citep{smith2024}");
  });

  it("turns installed-Codex multi-file output into reviewable changesets", async () => {
    const calls: string[] = [];
    let providerPrompt = "";
    const beforeMain = [
      "\\documentclass{article}",
      "\\begin{document}",
      "Intro text \\cite{doe2024}.",
      "\\begin{thebibliography}{1}",
      "\\bibitem{doe2024} Doe, A. (2024). Reference Study.",
      "\\end{thebibliography}",
      "\\end{document}",
      ""
    ].join("\n");
    const afterMain = [
      "\\documentclass{article}",
      "\\begin{document}",
      "Intro text \\cite{doe2024}.",
      "\\bibliographystyle{plain}",
      "\\bibliography{references}",
      "\\end{document}",
      ""
    ].join("\n");
    const references = [
      "@article{doe2024,",
      "  author = {Doe, A.},",
      "  title = {Reference Study},",
      "  year = {2024}",
      "}",
      ""
    ].join("\n");
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        providerPrompt = request.prompt;
        return Promise.resolve({
          action: "patch",
          targetFilePath: "main.tex",
          summary: "Use external BibTeX file",
          afterContents: afterMain,
          patches: [
            {
              targetFilePath: "main.tex",
              summary: "Use external BibTeX file",
              afterContents: afterMain
            },
            {
              targetFilePath: "references.bib",
              summary: "Create BibTeX bibliography",
              afterContents: references
            }
          ],
          message: "I prepared separate TeX and BibTeX patches.",
          notes: "Generated by fake Codex runner"
        });
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt:
          "Move the embedded bibliography into references.bib and remove it from main.tex.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls, {
        readFiles: {
          "main.tex": beforeMain,
          "references.bib": ""
        }
      })
    );

    expect(result.status).toBe("awaiting-approval");
    expect(result.changeset?.filePath).toBe("main.tex");
    expect(result.changesets?.map((changeset) => changeset.filePath)).toEqual([
      "main.tex",
      "references.bib"
    ]);
    expect(result.changesets?.map((changeset) => changeset.summary)).toEqual([
      "Use external BibTeX file",
      "Create BibTeX bibliography"
    ]);
    expect(providerPrompt).toContain(
      "populate patches with one entry per changed file"
    );
    expect(providerPrompt).toContain("splitting embedded bibliography entries");
    expect(calls).toEqual([
      "read-file:main.tex",
      "read-file:references.bib",
      "propose-patch",
      "propose-patch"
    ]);
    expect(result.events.filter((event) => event.type === "patch")).toHaveLength(2);
    expect(
      result.events.some(
        (event) =>
          event.type === "approval" &&
          event.prompt ===
            "Review the Codex patches before applying them to the project."
      )
    ).toBe(true);
  });

  it("uses focused Codex context for selected text writing edits", async () => {
    let providerPrompt = "";
    const source = [
      "\\documentclass{article}",
      "\\begin{document}",
      ...Array.from({ length: 80 }, (_, index) =>
        index === 40
          ? "We show the method is very good and it works well."
          : `Context line ${index + 1}.`
      ),
      "\\end{document}",
      ""
    ].join("\n");
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        providerPrompt = request.prompt;
        return Promise.resolve({
          action: "patch",
          targetFilePath: "main.tex",
          summary: "Improve selected sentence",
          afterContents: source.replace(
            "We show the method is very good and it works well.",
            "We demonstrate that the method performs robustly across the evaluated scenarios."
          ),
          message: "I prepared a focused rewrite.",
          notes: "Generated by fake Codex runner"
        });
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Rewrite the selected text while preserving the meaning.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        selectedText: "very good and it works well",
        selectionContext: {
          containingParagraph: "We show the method is very good and it works well.",
          endLine: 43,
          selectedText: "very good and it works well",
          selectionEndOffset: 47,
          selectionStartOffset: 22,
          startLine: 43
        }
      },
      createBroker([], { readFiles: { "main.tex": source } })
    );

    expect(result.status).toBe("awaiting-approval");
    expect(result.changeset?.summary).toBe("Improve selected sentence");
    expect(providerPrompt).toContain("focused writing edit");
    expect(providerPrompt).toContain("Change only the exact selected span");
    expect(providerPrompt).toContain("Focused file context");
    expect(providerPrompt).toContain("Context line 21.");
    expect(providerPrompt).toContain("Context line 61.");
    expect(providerPrompt).not.toContain("Context line 1.");
    expect(providerPrompt).not.toContain("Context line 80.");
    expect(providerPrompt).not.toContain("For table generation from pasted data");
    expect(providerPrompt).not.toContain("For unbalanced-brace repairs");
  });

  it("retries concrete fix answers once to request a reviewable patch", async () => {
    const calls: string[] = [];
    const prompts: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        prompts.push(request.prompt);
        if (prompts.length === 1) {
          return Promise.resolve(
            createCodexAnswer(
              "Add the missing \\end{document} line at the end of main.tex."
            )
          );
        }

        return Promise.resolve({
          action: "patch",
          targetFilePath: "main.tex",
          summary: "Add missing document end",
          afterContents:
            "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n",
          message: "I prepared a reviewable patch.",
          notes: "Retry produced patch"
        });
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Read the terminal log and fix the compile error.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls)
    );

    expect(result.status).toBe("awaiting-approval");
    expect(result.changeset?.summary).toBe("Add missing document end");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Retry instruction:");
    expect(prompts[1]).toContain('return action "patch"');
    expect(prompts[1]).toContain('return action "delete-entry"');
    expect(prompts[1]).toContain('return action "move-entry"');
    expect(prompts[1]).toContain('return action "set-main-file"');
    expect(prompts[1]).toContain('return action "run-compile"');
    expect(calls).toEqual(["read-file:main.tex", "propose-patch"]);
  });

  it("retries interrupted Codex planner runs once with focused context", async () => {
    const calls: string[] = [];
    const prompts: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        prompts.push(request.prompt);
        if (prompts.length === 1) {
          throw new Error("codex was terminated by SIGTERM: stdio transport closed");
        }

        return Promise.resolve({
          action: "patch",
          targetFilePath: "main.tex",
          summary: "Add missing document end",
          afterContents:
            "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n",
          message: "I prepared a reviewable patch after retrying.",
          notes: "Focused retry produced patch"
        });
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Fix the compile error.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex",
        diagnostic: {
          severity: "error",
          filePath: "main.tex",
          line: 3,
          message: "Emergency stop"
        }
      },
      createBroker(calls)
    );

    expect(result.status).toBe("awaiting-approval");
    expect(result.changeset?.summary).toBe("Add missing document end");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("previous Codex planner attempt was interrupted");
    expect(prompts[1]).toContain("avoid broad project scans");
    expect(prompts[1]).toContain("Emergency stop");
    expect(calls).toEqual(["read-file:main.tex", "propose-patch"]);
    expect(
      result.events.some(
        (event) =>
          event.type === "tool-call" &&
          event.toolName === "codex-exec" &&
          event.status === "failed" &&
          event.summary.includes("SIGTERM") &&
          event.summary.includes("Retrying")
      )
    ).toBe(true);
  });

  it("rejects overbroad large-file patches and retries for a complete file", async () => {
    const calls: string[] = [];
    const prompts: string[] = [];
    const largeFile = [
      "\\documentclass{article}",
      "\\usepackage{graphicx}",
      "\\begin{document}",
      ...Array.from({ length: 180 }, (_, index) => `Paragraph ${index}.`),
      "\\bibliography{references.bib}",
      "\\end{document}",
      ""
    ].join("\n");
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        prompts.push(request.prompt);
        if (prompts.length === 1) {
          return Promise.resolve({
            action: "patch",
            targetFilePath: "main.tex",
            summary: "Add graphics path",
            afterContents:
              "\\documentclass{article}\n\\usepackage{graphicx}\n\\graphicspath{{figures/}}\n",
            message: "I added the graphics path.",
            notes: "Returned an incomplete patch"
          });
        }

        return Promise.resolve({
          action: "patch",
          targetFilePath: "main.tex",
          summary: "Add graphics path",
          afterContents: largeFile.replace(
            "\\usepackage{graphicx}",
            "\\usepackage{graphicx}\n\\graphicspath{{figures/}}"
          ),
          message: "I added the graphics path while preserving the full file.",
          notes: "Returned a complete patch"
        });
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Fix the root-relative graphics path.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls, { readFiles: { "main.tex": largeFile } })
    );

    expect(result.status).toBe("awaiting-approval");
    expect(result.changeset?.summary).toBe("Add graphics path");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("previous patch removed most of a large file");
    expect(prompts[1]).toContain("complete target file");
    expect(calls).toEqual(["read-file:main.tex", "propose-patch"]);
    expect(
      result.events.some(
        (event) =>
          event.type === "tool-call" &&
          event.toolName === "codex-exec" &&
          event.status === "running" &&
          event.summary.includes("removed most of a large file")
      )
    ).toBe(true);
  });

  it("blocks multi-file patches when one file remains overbroad after retry", async () => {
    const calls: string[] = [];
    const prompts: string[] = [];
    const largeFile = [
      "\\documentclass{article}",
      "\\begin{document}",
      ...Array.from({ length: 180 }, (_, index) => `Paragraph ${index}.`),
      "\\begin{thebibliography}{1}",
      "\\bibitem{doe2024} Doe, A. (2024). Reference Study.",
      "\\end{thebibliography}",
      "\\end{document}",
      ""
    ].join("\n");
    const incompleteMain = [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\bibliography{references}",
      "\\end{document}",
      ""
    ].join("\n");
    const references = "@article{doe2024, title = {Reference Study}, year = {2024}}\n";
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        prompts.push(request.prompt);
        return Promise.resolve({
          action: "patch",
          targetFilePath: "main.tex",
          summary: "Extract bibliography",
          afterContents: incompleteMain,
          patches: [
            {
              targetFilePath: "main.tex",
              summary: "Use external bibliography",
              afterContents: incompleteMain
            },
            {
              targetFilePath: "references.bib",
              summary: "Create bibliography file",
              afterContents: references
            }
          ],
          message: "I extracted the bibliography.",
          notes:
            prompts.length === 1
              ? "Returned an incomplete multi-file patch"
              : "Returned another incomplete multi-file patch"
        });
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt:
          "Move the embedded bibliography into references.bib and keep the rest of main.tex.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls, {
        readFiles: {
          "main.tex": largeFile,
          "references.bib": ""
        }
      })
    );

    expect(result.status).toBe("completed");
    expect(result.changeset).toBeUndefined();
    expect(result.changesets).toBeUndefined();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("previous patch removed most of a large file");
    expect(calls).toEqual([
      "read-file:main.tex",
      "read-file:references.bib",
      "read-file:references.bib"
    ]);
    expect(result.events.some((event) => event.type === "patch")).toBe(false);
    expect(
      result.events.some(
        (event) =>
          event.type === "tool-call" &&
          event.toolName === "propose-patch" &&
          event.status === "blocked"
      )
    ).toBe(true);
  });

  it("does not retry non-transient Codex planner failures", async () => {
    const prompts: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        prompts.push(request.prompt);
        throw new Error(
          "Codex output did not match the expected agent response schema."
        );
      }
    });

    await expect(
      provider.startSession(
        {
          providerId: "openai-codex",
          mode: "apply-with-review",
          projectRoot: "/tmp/project",
          prompt: "Fix the compile error.",
          activeFilePath: "main.tex",
          mainFilePath: "main.tex",
          compiler: "pdflatex"
        },
        createBroker()
      )
    ).rejects.toThrow("expected agent response schema");
    expect(prompts).toHaveLength(1);
  });

  it("applies Codex patches and compiles in autonomous-local mode", async () => {
    const calls: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: () =>
        Promise.resolve({
          action: "patch",
          targetFilePath: "main.tex",
          summary: "Add missing document end",
          afterContents:
            "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n",
          message: "I fixed the missing document terminator.",
          notes: "Generated by fake Codex runner"
        })
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "autonomous-local",
        projectRoot: "/tmp/project",
        prompt: "Fix the compile error and recompile.",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls)
    );

    expect(result.status).toBe("completed");
    expect(result.changeset?.status).toBe("applied");
    expect(result.buildResult?.status).toBe("succeeded");
    expect(calls).toEqual([
      "read-file:main.tex",
      "propose-patch",
      "apply-patch:changeset-1",
      "run-compile"
    ]);
    expect(
      result.events.some(
        (event) =>
          event.type === "tool-call" &&
          event.toolName === "apply-patch" &&
          event.status === "succeeded"
      )
    ).toBe(true);
    expect(
      result.events.some(
        (event) =>
          event.type === "verification" &&
          event.status === "passed" &&
          event.buildJobId === "build-1"
      )
    ).toBe(true);
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.role === "assistant" &&
          event.content === "I fixed the missing document terminator."
      )
    ).toBe(true);
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.role === "assistant" &&
          (event.content.includes("Diagnostics:") ||
            event.content.includes("Compile succeeded.") ||
            event.content.includes("I applied 1 patch"))
      )
    ).toBe(false);
  });

  it("turns file move requests into a project-scoped app tool call", async () => {
    const calls: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: () =>
        Promise.resolve({
          action: "move-entry",
          targetFilePath: "fig1.png",
          summary: "Move figure next to manuscript path",
          afterContents: "figures/fig1.png",
          message: "I moved `fig1.png` to `figures/fig1.png`.",
          notes: "Generated by fake Codex runner"
        })
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "autonomous-local",
        projectRoot: "/tmp/project",
        prompt: "Move fig1.png into figures/fig1.png",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls)
    );

    expect(result.status).toBe("completed");
    expect(result.moveEntries).toEqual([
      { fromPath: "fig1.png", toPath: "figures/fig1.png" }
    ]);
    expect(calls).toEqual([
      "read-file:main.tex",
      "move-entry:fig1.png->figures/fig1.png"
    ]);
    expect(
      result.events.some(
        (event) =>
          event.type === "tool-call" &&
          event.toolName === "move-entry" &&
          event.status === "succeeded"
      )
    ).toBe(true);
  });

  it("turns file delete requests into an approval-gated app tool call", async () => {
    const calls: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: () =>
        Promise.resolve({
          action: "delete-entry",
          targetFilePath: "references.bib",
          summary: "Remove unused bibliography file",
          afterContents: "",
          message: "I can remove `references.bib` from the project after approval.",
          notes: "Generated by fake Codex runner"
        })
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "apply-with-review",
        projectRoot: "/tmp/project",
        prompt: "Remove references.bib from project",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls)
    );

    expect(result.status).toBe("awaiting-approval");
    expect(result.deleteEntries).toEqual([{ path: "references.bib" }]);
    expect(calls).toEqual(["read-file:main.tex"]);
    expect(
      result.events.some(
        (event) =>
          event.type === "approval" &&
          event.toolName === "delete-entry" &&
          event.status === "requested" &&
          event.prompt.includes("Delete references.bib")
      )
    ).toBe(true);
  });

  it("turns main-file change requests into an app tool call", async () => {
    const calls: string[] = [];
    const prompts: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        prompts.push(request.prompt);
        if (prompts.length === 1) {
          return Promise.resolve(
            createCodexAnswer(
              "The project already appears to use an IEEE Transactions file."
            )
          );
        }

        return Promise.resolve({
          action: "set-main-file",
          targetFilePath: "IEEE trans journal.tex",
          summary: "Set IEEE Transactions file as main",
          afterContents: "",
          message: "I set the project main TeX file to `IEEE trans journal.tex`.",
          notes: "Retry produced app tool action"
        });
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "autonomous-local",
        projectRoot: "/tmp/project",
        prompt: "change the main tex to ieee trans journal file",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls)
    );

    expect(result.status).toBe("completed");
    expect(prompts).toHaveLength(2);
    expect(calls).toEqual([
      "read-file:main.tex",
      "set-main-file:IEEE trans journal.tex"
    ]);
    expect(
      result.events.some(
        (event) =>
          event.type === "tool-call" &&
          event.toolName === "set-main-file" &&
          event.status === "succeeded"
      )
    ).toBe(true);
  });

  it("turns compile requests into an app build tool call", async () => {
    const calls: string[] = [];
    const prompts: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        prompts.push(request.prompt);
        if (prompts.length === 1) {
          return Promise.resolve(
            createCodexAnswer(
              "I attempted to recompile, but the read-only environment prevented LaTeX from writing main.aux."
            )
          );
        }

        return Promise.resolve({
          action: "run-compile",
          targetFilePath: "main.tex",
          summary: "Run project compile",
          afterContents: "",
          message: "I ran the project compile.",
          notes: "Retry produced app build action"
        });
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "autonomous-local",
        projectRoot: "/tmp/project",
        prompt: "recompile to make sure there is no error",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls)
    );

    expect(result.status).toBe("completed");
    expect(result.buildResult?.status).toBe("succeeded");
    expect(prompts).toHaveLength(2);
    expect(calls).toEqual(["read-file:main.tex", "run-compile"]);
    expect(
      result.events.some(
        (event) =>
          event.type === "tool-call" &&
          event.toolName === "run-compile" &&
          event.status === "succeeded"
      )
    ).toBe(true);
    expect(
      result.events.some(
        (event) =>
          event.type === "verification" &&
          event.status === "passed" &&
          event.buildJobId === "build-1"
      )
    ).toBe(true);
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.role === "assistant" &&
          event.content.includes("I ran the project compile.") &&
          event.content.includes(
            "Compile finished. Build details are available in the Log panel."
          ) &&
          !event.content.includes("Diagnostics:") &&
          !event.content.includes("Compile succeeded.")
      )
    ).toBe(true);
  });

  it("repairs a failed autonomous compile and recompiles before answering", async () => {
    const calls: string[] = [];
    const prompts: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        prompts.push(request.prompt);
        if (prompts.length === 1) {
          return Promise.resolve({
            action: "run-compile",
            targetFilePath: "main.tex",
            summary: "Run project compile",
            afterContents: "",
            message: "I will compile the project.",
            notes: "Initial compile action"
          });
        }

        return Promise.resolve({
          action: "patch",
          targetFilePath: "main.tex",
          summary: "Fix missing input path",
          afterContents:
            "\\documentclass{article}\n\\begin{document}\n\\input{tracked.tex}\n\\end{document}\n",
          message: "I fixed the missing input path.",
          notes: "Repair patch produced from compile log"
        });
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "autonomous-local",
        projectRoot: "/tmp/project",
        prompt: "compile again the main tex file",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls, {
        compileResults: [
          createBuildResult({
            diagnostics: [
              {
                severity: "error",
                filePath: "main.tex",
                line: 1,
                message: "File `tracked.tex' not found."
              }
            ],
            jobId: "build-failed",
            rawLog: "! LaTeX Error: File `tracked.tex' not found.",
            status: "failed"
          }),
          createBuildResult({
            artifact: {
              byteLength: 1234,
              pdfPath: "main.pdf",
              updatedAt: "2026-06-08T00:00:02.000Z"
            },
            jobId: "build-fixed",
            rawLog: "Output written on main.pdf",
            status: "succeeded"
          })
        ],
        readFiles: {
          "main.tex":
            "\\documentclass{article}\n\\begin{document}\n\\input{missing.tex}\n"
        }
      })
    );

    expect(result.status).toBe("completed");
    expect(result.changeset?.status).toBe("applied");
    expect(result.buildResult?.status).toBe("succeeded");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Compile repair instruction:");
    expect(prompts[1]).toContain("File `tracked.tex' not found.");
    expect(prompts[1]).toContain("! LaTeX Error: File `tracked.tex' not found.");
    expect(calls).toEqual([
      "read-file:main.tex",
      "run-compile",
      "propose-patch",
      "apply-patch:changeset-1",
      "run-compile",
      "read-file:main.tex"
    ]);
    expect(
      result.events.some(
        (event) =>
          event.type === "tool-call" &&
          event.toolName === "codex-exec" &&
          event.summary.includes("Compile failed; asking Codex to repair")
      )
    ).toBe(true);
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.role === "assistant" &&
          event.content.includes(
            "I fixed the compile issue and recompiled successfully"
          )
      )
    ).toBe(true);
  });

  it("reports a failed compile when Codex cannot produce a safe repair patch", async () => {
    const calls: string[] = [];
    const prompts: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        prompts.push(request.prompt);
        if (prompts.length === 1) {
          return Promise.resolve({
            action: "run-compile",
            targetFilePath: "main.tex",
            summary: "Run project compile",
            afterContents: "",
            message: "I will compile the project.",
            notes: "Initial compile action"
          });
        }

        return Promise.resolve(
          createCodexAnswer("The compile failure requires a missing external file.")
        );
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "autonomous-local",
        projectRoot: "/tmp/project",
        prompt: "compile again the main tex file",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker(calls, {
        compileResults: [
          createBuildResult({
            diagnostics: [
              {
                severity: "error",
                filePath: "main.tex",
                line: 1,
                message: "File `outside.tex' not found."
              }
            ],
            jobId: "build-failed",
            rawLog: "! LaTeX Error: File `outside.tex' not found.",
            status: "failed"
          })
        ]
      })
    );

    expect(result.status).toBe("completed");
    expect(result.changeset).toBeUndefined();
    expect(result.buildResult?.status).toBe("failed");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Compile repair instruction:");
    expect(calls).toEqual(["read-file:main.tex", "run-compile"]);
    expect(
      result.events.some(
        (event) =>
          event.type === "message" &&
          event.role === "assistant" &&
          event.content.includes("did not return a safe source patch")
      )
    ).toBe(true);
  });

  it("does not retry answer-only questions in autonomous mode", async () => {
    const prompts: string[] = [];
    const provider = new CodexCliProvider({
      runCodexExec: (request) => {
        prompts.push(request.prompt);
        return Promise.resolve(createCodexAnswer("This paper is about local editing."));
      }
    });

    const result = await provider.startSession(
      {
        providerId: "openai-codex",
        mode: "autonomous-local",
        projectRoot: "/tmp/project",
        prompt: "What is this paper about?",
        activeFilePath: "main.tex",
        mainFilePath: "main.tex",
        compiler: "pdflatex"
      },
      createBroker()
    );

    expect(result.status).toBe("completed");
    expect(result.changeset).toBeUndefined();
    expect(prompts).toHaveLength(1);
  });
});

function createCodexAnswer(message: string) {
  return {
    action: "answer" as const,
    targetFilePath: "main.tex",
    summary: "Answer user question",
    afterContents: "\\documentclass{article}\n\\begin{document}\nHello\n",
    message,
    notes: "Answered by fake Codex runner"
  };
}

function createSingleStepWorkflow(stepId: DesignWorkflowStepId): DesignWorkflowOutput {
  const data =
    stepId === "brand-story"
      ? createCafeBrandStoryData()
      : stepId === "information-architecture"
        ? createCafeInformationArchitectureData()
        : stepId === "creative-direction"
          ? createCafeCreativeDirectionData()
          : stepId === "section-design"
            ? createCafeSectionDesignData()
            : stepId === "responsive-layout"
              ? createCafeResponsiveLayoutData()
              : stepId === "interaction-motion"
                ? createCafeInteractionMotionData()
                : stepId === "accessibility-review"
                  ? createCafeAccessibilityReviewData()
                  : stepId === "final-polish"
                    ? createCafeFinalPolishData()
                    : createEmptyWorkflowStepData();
  const outputKindByStep: Record<
    DesignWorkflowStepId,
    DesignWorkflowOutput["steps"][number]["output"]["kind"]
  > = {
    "brand-story": "brief",
    "information-architecture": "sitemap",
    "creative-direction": "style-system",
    "section-design": "section-spec",
    "responsive-layout": "breakpoint-rules",
    "interaction-motion": "interaction-spec",
    "accessibility-review": "accessibility-checklist",
    "qa-review": "qa-report",
    "code-generation": "implementation-plan",
    "implementation-qa": "runtime-qa-report",
    "final-polish": "polish-report"
  };
  const definition = openRouterDesignWorkflowStepDefinitions[stepId];
  const workflow = createCafeWebsiteWorkflow();

  return {
    ...createEmptyDesignWorkflowOutput(),
    ...(stepId === "qa-review" ? { qa: workflow.qa } : {}),
    ...(stepId === "code-generation"
      ? { codeGeneration: workflow.codeGeneration }
      : {}),
    ...(stepId === "implementation-qa"
      ? { implementationQa: workflow.implementationQa }
      : {}),
    currentStep: stepId,
    steps: [
      {
        id: stepId,
        title: definition.title,
        status: "ready-for-review",
        objective: definition.objective,
        output: {
          kind: outputKindByStep[stepId],
          summary: `${definition.title} output for Lumen & Loaf.`,
          data
        }
      }
    ]
  };
}

function createCafeBrandStoryData() {
  return {
    ...createEmptyWorkflowStepData(),
    brandName: "Lumen & Loaf",
    businessType: "Neighborhood cafe and bakery",
    positioning:
      "A quiet neighborhood cafe for slow mornings, warm bread, and window-seat work.",
    audience: [
      "remote workers looking for a calm weekday table",
      "readers and students who stay for a second cup",
      "weekend brunch visitors",
      "neighbors picking up a loaf"
    ],
    brandPromise:
      "A slower, more thoughtful morning anchored by good coffee, warm bread, and natural light.",
    mood: ["warm", "literary", "sunlit", "tactile", "calm", "local"],
    storyPremise:
      "Every morning, bread cools near the counter while sunlight crosses the front tables and the handwritten menu changes with the day.",
    sensoryAnchors: [
      "cardamom buns after 9",
      "ceramic cups warming in sunlight",
      "honey oat sourdough cooling on racks",
      "folded newspapers by the window"
    ],
    toneOfVoice: {
      personality: ["quiet", "observant", "generous", "specific"],
      copyRules: [
        "Use concrete sensory details instead of generic cafe claims.",
        "Prefer short poetic lines over marketing slogans.",
        "Make the cafe feel local and lived-in."
      ]
    },
    differentiators: [
      "small daily bread batches",
      "quiet tables designed for reading and writing",
      "seasonal menu details that change by time of day"
    ],
    antiPatterns: [
      "generic coffee shop hero copy",
      "dark moody espresso-bar styling",
      "corporate productivity cafe language"
    ]
  };
}

function createEmptyWorkflowStepData() {
  return {
    brandName: "",
    businessType: "",
    positioning: "",
    audience: [],
    brandPromise: "",
    mood: [],
    storyPremise: "",
    sensoryAnchors: [],
    toneOfVoice: {
      personality: [],
      copyRules: []
    },
    differentiators: [],
    antiPatterns: [],
    sections: [],
    palette: [],
    photography: "",
    section: "",
    headline: "",
    primaryCta: "",
    secondaryCta: "",
    breakpoints: [],
    hover: "",
    reducedMotion: "",
    contrast: "",
    tapTargets: "",
    passNumber: 0,
    components: [],
    acceptedRisks: [],
    websiteStoryArc: [],
    sectionsDetailed: [],
    sectionOrder: [],
    primaryUserPaths: [],
    ctaPriority: [],
    navigationModel: {
      type: "",
      primaryItems: [],
      secondaryItems: [],
      mobileBehavior: "",
      stickyBehavior: ""
    },
    contentRequirements: [],
    handoffToCreativeDirection: {
      nextStepFocus: [],
      visualQuestions: [],
      contentRisks: []
    },
    colorSystem: [],
    typographySystem: {
      heading: "",
      body: "",
      navigation: "",
      scale: [],
      rules: []
    },
    imageDirection: {
      subjects: [],
      lighting: "",
      framing: [],
      avoid: []
    },
    compositionPrinciples: [],
    spacingRhythm: [],
    textureMaterialRules: [],
    iconIllustrationRules: [],
    ctaSystem: {
      primary: "",
      secondary: "",
      focus: "",
      rules: []
    },
    motionMood: {
      principles: [],
      hover: "",
      transitions: "",
      reducedMotion: ""
    },
    sectionProgression: [],
    handoffToSectionDesign: {
      prioritySections: [],
      layoutQuestions: [],
      assetRequests: [],
      risks: []
    },
    sectionDesigns: [],
    responsiveRules: [],
    interactionRules: [],
    accessibilityChecks: [],
    polishChecks: []
  };
}

function createCafeInformationArchitectureData() {
  return {
    ...createCafeBrandStoryData(),
    storyPremise:
      "Website story arc: first establish the morning atmosphere, then make menu discovery immediate, prove bread and coffee craft, show how the room supports calm visits, and close with practical visit action.",
    sections: [
      "hero",
      "daily-counter",
      "bread-program",
      "coffee-pairings",
      "the-room",
      "seasonal-notes",
      "visit-details",
      "closing-invitation"
    ],
    section:
      "Information architecture handoff for a single-page cafe website with clear visit intent.",
    headline: "Single-page cafe story from morning atmosphere to visit action",
    primaryCta: "View Menu",
    secondaryCta: "Get Directions",
    websiteStoryArc: [
      "Create immediate recognition: cafe, bakery, light, and neighborhood calm.",
      "Let visitors quickly check menu, hours, and directions.",
      "Prove craft through bread, pastry, coffee, and seasonal rhythm.",
      "Show the room as useful for morning stops, quiet work, and unhurried meetings.",
      "Close with practical visit details and a simple invitation."
    ],
    sectionsDetailed: [
      {
        id: "hero",
        title: "Hero / Visit Intent",
        purpose: "Introduce the brand and let visitors act quickly.",
        storyRole: "First impression and practical orientation.",
        primaryContent: [
          "brand name",
          "literal cafe and bakery offer",
          "today-focused cue",
          "menu and directions actions"
        ],
        cta: "View Menu",
        requiredEvidence: ["current hours", "location cue", "menu availability"]
      },
      {
        id: "daily-counter",
        title: "Daily Counter",
        purpose: "Preview the rotating menu without overpromising inventory.",
        storyRole: "Discovery and appetite.",
        primaryContent: ["coffee", "bread", "pastries", "simple cafe fare"],
        cta: "See Today's Menu",
        requiredEvidence: ["representative items", "availability language"]
      },
      {
        id: "bread-program",
        title: "Bread & Bake Program",
        purpose: "Explain the in-house bread and pastry differentiator.",
        storyRole: "Craft proof.",
        primaryContent: ["sourdough rhythm", "seasonal pastries", "visible baking"],
        cta: "Explore Bakes",
        requiredEvidence: ["bake schedule", "signature loaf", "ingredient cue"]
      },
      {
        id: "coffee-pairings",
        title: "Coffee Pairings",
        purpose: "Connect the coffee program to bread and pastry choices.",
        storyRole: "Flavor pairing and daily ritual.",
        primaryContent: ["filter coffee", "espresso", "seasonal drinks", "pairings"],
        cta: "Match Coffee With Bakes",
        requiredEvidence: ["coffee source cue", "pairing examples", "drink range"]
      },
      {
        id: "the-room",
        title: "The Room",
        purpose: "Show whether the space supports lingering, work, and conversation.",
        storyRole: "Practical atmosphere proof.",
        primaryContent: ["seating", "window light", "table rhythm", "ambient policy"],
        cta: "See the Space",
        requiredEvidence: ["room photography", "seating cue", "visit etiquette"]
      },
      {
        id: "seasonal-notes",
        title: "Seasonal Notes",
        purpose: "Give the cafe a living editorial rhythm without becoming a blog.",
        storyRole: "Freshness and neighborhood cadence.",
        primaryContent: ["market produce", "daily bake note", "short staff note"],
        cta: "Read Today's Note",
        requiredEvidence: ["update date", "seasonal ingredient", "short note owner"]
      },
      {
        id: "visit-details",
        title: "Visit Details",
        purpose: "Resolve practical questions before the visitor leaves the page.",
        storyRole: "Conversion and reassurance.",
        primaryContent: ["hours", "address", "transit", "accessibility", "contact"],
        cta: "Get Directions",
        requiredEvidence: ["current hours", "full address", "contact channel"]
      },
      {
        id: "closing-invitation",
        title: "Closing Invitation",
        purpose: "End with a simple repeatable reason to visit.",
        storyRole: "Memory hook and soft close.",
        primaryContent: ["quiet invitation", "today cue", "direction reminder"],
        cta: "Plan Your Visit",
        requiredEvidence: ["brand promise", "primary CTA", "secondary contact path"]
      }
    ],
    sectionOrder: [
      "hero",
      "daily-counter",
      "bread-program",
      "coffee-pairings",
      "the-room",
      "seasonal-notes",
      "visit-details",
      "closing-invitation"
    ],
    primaryUserPaths: [
      {
        id: "local-morning-stop",
        audience: "Local residents",
        intent: "Check whether the cafe is open and worth visiting now.",
        steps: ["hero", "daily-counter", "visit-details"],
        conversionGoal: "Get directions"
      },
      {
        id: "remote-work-visit",
        audience: "Remote workers and students",
        intent: "Decide whether the room supports a calm work session.",
        steps: ["hero", "the-room", "visit-details"],
        conversionGoal: "Plan a visit"
      }
    ],
    ctaPriority: [
      {
        rank: 1,
        label: "View Menu",
        targetSection: "daily-counter",
        intent: "Support immediate menu discovery."
      },
      {
        rank: 2,
        label: "Get Directions",
        targetSection: "visit-details",
        intent: "Convert interest into a visit."
      }
    ],
    navigationModel: {
      type: "single-page anchor navigation",
      primaryItems: ["Menu", "Bread", "Coffee", "Space", "Visit"],
      secondaryItems: ["Contact"],
      mobileBehavior: "Compact menu with the same anchors and visible visit action.",
      stickyBehavior: "Quiet sticky desktop nav after the hero."
    },
    contentRequirements: [
      "current hours",
      "address and location cues",
      "menu categories",
      "representative bread and pastry items",
      "coffee program details",
      "seating or work policy",
      "accessibility and transit notes"
    ],
    handoffToCreativeDirection: {
      nextStepFocus: [
        "Translate story arc into light-only visual hierarchy.",
        "Define photography needs for hero, bread, counter, and room sections."
      ],
      visualQuestions: [
        "How much of the next section should be visible below the hero?",
        "How can menu details feel current without becoming promotional clutter?"
      ],
      contentRisks: [
        "Generic cafe section labels could flatten the story.",
        "Too many CTAs could weaken the simple visit path."
      ]
    }
  };
}

function createCafeCreativeDirectionData() {
  return {
    ...createCafeInformationArchitectureData(),
    palette: [
      "Warm ivory #F8F3E8",
      "Sun-washed cream #FFF9EC",
      "Loaf crust #B8783E",
      "Coffee ink #3F3328",
      "Sage leaf #8D9B72",
      "Ceramic blue #7E9AA6"
    ],
    photography:
      "Bright natural-light cafe and bakery photography with bread racks, ceramic cups, handwritten menus, window tables, and folded newspapers.",
    section: "creative-direction",
    headline: "Sunlit, tactile, literary neighborhood bakery-cafe",
    primaryCta: "See today's menu",
    secondaryCta: "Plan a visit",
    hover:
      "Soft underline movement for text links, wheat tint on buttons, and minimal lift only where it clarifies affordance.",
    reducedMotion: "All motion falls back to simple opacity or instant state changes.",
    contrast:
      "Coffee ink on ivory or cream for body text, with crust and sage accents only where contrast remains readable.",
    tapTargets: "44px minimum on touch layouts.",
    colorSystem: [
      {
        name: "Warm ivory",
        value: "#F8F3E8",
        role: "page base",
        usage: ["global background", "large reading surfaces"]
      },
      {
        name: "Loaf crust",
        value: "#B8783E",
        role: "primary warmth",
        usage: ["primary CTA", "active states", "small highlights"]
      },
      {
        name: "Coffee ink",
        value: "#3F3328",
        role: "main text",
        usage: ["headings", "body copy", "navigation"]
      }
    ],
    typographySystem: {
      heading: "Literary serif with plainspoken proportions",
      body: "Highly readable humanist sans",
      navigation: "Compact sans with clear anchor labels",
      scale: ["hero display", "section title", "body", "metadata"],
      rules: [
        "Use expressive serif only for true headings.",
        "Keep menu, hours, and utility information in readable sans.",
        "Avoid handwritten fonts for body text."
      ]
    },
    imageDirection: {
      subjects: [
        "bread racks",
        "ceramic cups",
        "window tables",
        "handwritten menus",
        "folded newspapers"
      ],
      lighting: "bright natural morning light",
      framing: [
        "inspectable product details",
        "negative space for hero copy",
        "room context for visit decisions"
      ],
      avoid: ["dark espresso-bar mood", "blurred stock-like crops", "generic latte art"]
    },
    compositionPrinciples: [
      "Let the first viewport immediately signal cafe and bakery.",
      "Keep practical visit information easy to scan.",
      "Show a hint of the next section below the hero."
    ],
    spacingRhythm: [
      "Generous section padding for slow editorial pacing.",
      "Tighter internal spacing for menu and hours utility blocks.",
      "Stable CTA spacing across touch and desktop layouts."
    ],
    textureMaterialRules: [
      "Use paper, ceramic, and bread-rack details sparingly.",
      "Prefer real material cues over abstract decoration.",
      "Avoid heavy shadows and glossy surfaces."
    ],
    iconIllustrationRules: [
      "Use simple line icons only for utility cues.",
      "Acceptable icons: cup, loaf, clock, map pin, note.",
      "No mascot, cartoon, or decorative icon clutter."
    ],
    ctaSystem: {
      primary: "Filled loaf-crust button",
      secondary: "Ink text button or wheat outline",
      focus: "High-contrast outline that remains visible on light surfaces",
      rules: [
        "Use one primary CTA per major section.",
        "Keep visit and today's menu actions most prominent.",
        "Do not over-style secondary links."
      ]
    },
    motionMood: {
      principles: ["slow", "observational", "quiet", "non-essential"],
      hover: "Subtle material response, never playful bounce.",
      transitions: "Gentle header reveal and image fade.",
      reducedMotion: "Disable reveal movement and preserve instant access to content."
    },
    sectionProgression: [
      {
        sectionId: "hero",
        visualRole: "luminous arrival",
        treatment: "full-bleed sunlit cafe image with clear brand signal"
      },
      {
        sectionId: "daily-counter",
        visualRole: "freshness and immediacy",
        treatment: "handwritten-board inspired list with tactile product details"
      },
      {
        sectionId: "bread-program",
        visualRole: "central bread ritual",
        treatment: "warm product-focused layout with bake schedule support"
      },
      {
        sectionId: "visit-details",
        visualRole: "practical anchor",
        treatment: "clear utility layout with map, hours, and access details"
      }
    ],
    handoffToSectionDesign: {
      prioritySections: ["hero", "daily-counter", "bread-program", "visit-details"],
      layoutQuestions: [
        "How much of the next section should show below the hero?",
        "Where should today's board sit relative to menu and bread?",
        "How prominent should loaf reservation be?"
      ],
      assetRequests: [
        "sunlit hero image with bread and cafe table",
        "bread rack image",
        "handwritten menu board detail",
        "room or window-seat image"
      ],
      risks: [
        "Palette may become too cream-heavy without blue or sage contrast.",
        "Handwritten details can harm readability if used as body copy.",
        "Too many CTAs can weaken the visit path."
      ]
    }
  };
}

function createCafeSectionDesignData() {
  return {
    ...createCafeCreativeDirectionData(),
    section: "hero",
    headline: "Lumen & Loaf",
    primaryCta: "See today's menu",
    secondaryCta: "Plan a visit",
    sectionDesigns: [
      {
        id: "hero",
        storyRole: "Luminous arrival and immediate visit intent.",
        layout:
          "Full-bleed image-led hero with left-aligned copy in natural negative space and a visible hint of the Today section below the fold.",
        elements: [
          "brand H1",
          "sensory subheadline",
          "today menu CTA",
          "visit CTA",
          "small hours/location note"
        ],
        visualAssets: [
          "sunlit cafe table image",
          "bread rack detail",
          "handwritten menu texture"
        ],
        assetPlacement:
          "Primary image fills the viewport width; copy sits over the calmest light area with a subtle readable overlay only if needed.",
        ctas: ["See today's menu", "Plan a visit"],
        responsiveNotes: [
          "Stack CTAs on mobile.",
          "Keep H1 and CTA group above the next-section hint.",
          "Avoid cropping out bread or cafe cues on narrow screens."
        ],
        acceptanceCriteria: [
          "Hero could not belong to a generic cafe.",
          "Brand, bread, light, and practical visit intent are visible in the first viewport.",
          "No text overlaps or CTA crowding on mobile."
        ]
      }
    ]
  };
}

function createCafeResponsiveLayoutData() {
  return {
    ...createCafeSectionDesignData(),
    breakpoints: ["375", "768", "1024", "1440"],
    responsiveRules: [
      {
        viewport: "mobile",
        layout: "Single-column hero copy with stacked CTAs and next-section hint.",
        typography: "Reduce display scale while keeping body text at least 16px.",
        navigation: "Compact menu with Today and Visit actions prioritized.",
        assets: "Crop hero image to preserve bread, cup, and window-light cues.",
        constraints: ["no horizontal scroll", "44px tap targets", "no text overlap"]
      },
      {
        viewport: "desktop",
        layout:
          "Wide image composition with copy in left third and Today's board peeking below.",
        typography: "Hero display can scale up with fixed max line length.",
        navigation: "Light sticky anchor navigation after hero threshold.",
        assets: "Use full image width with stable aspect ratio and reserved height.",
        constraints: ["keep next section visible", "avoid card hero", "stable CTA row"]
      }
    ]
  };
}

function createCafeInteractionMotionData() {
  return {
    ...createCafeResponsiveLayoutData(),
    interactionRules: [
      {
        trigger: "hover",
        target: "primary CTA",
        feedback: "Loaf-crust button warms slightly and keeps text contrast.",
        motion: "150ms ease-out color and subtle transform.",
        accessibility: "Hover is mirrored by focus-visible state.",
        reducedMotion: "Disable transform and keep color/focus change."
      },
      {
        trigger: "scroll",
        target: "sticky header",
        feedback: "Header appears with a soft border after hero threshold.",
        motion: "Brief opacity transition without layout shift.",
        accessibility: "Header anchors remain keyboard reachable.",
        reducedMotion: "Header appears instantly."
      }
    ]
  };
}

function createCafeAccessibilityReviewData() {
  return {
    ...createCafeInteractionMotionData(),
    accessibilityChecks: [
      {
        id: "A11Y-001",
        target: "hero text over image",
        requirement: "Normal text must meet 4.5:1 contrast.",
        method: "Check foreground/background pair against final hero image crop.",
        status: "needs-visual-evidence",
        fix: "Add a light-only contrast treatment or reposition copy if image contrast fails."
      },
      {
        id: "A11Y-002",
        target: "CTA group",
        requirement: "Touch targets must be at least 44px high with visible focus.",
        method: "Inspect mobile and keyboard states.",
        status: "ready-for-design-qa",
        fix: "Increase button height or spacing if viewport QA finds crowding."
      }
    ]
  };
}

function createCafeFinalPolishData() {
  return {
    ...createCafeAccessibilityReviewData(),
    polishChecks: [
      {
        target: "story continuity",
        criterion: "Each section advances from morning arrival to local participation.",
        status: "pass",
        recommendation: "Keep Today's board and bread ritual before community content."
      },
      {
        target: "visual cohesion",
        criterion: "Palette, type, texture, and image style remain light and tactile.",
        status: "pass",
        recommendation:
          "Use ceramic blue sparingly to avoid a cream-only visual system."
      }
    ]
  };
}

function createCafeWebsiteWorkflow(): DesignWorkflowOutput {
  const steps: DesignWorkflowOutput["steps"] = [
    {
      id: "brand-story",
      title: "Brand & Story",
      status: "passed",
      objective: "Define the cafe identity and narrative anchors.",
      output: {
        kind: "brief",
        summary: "Lumen & Loaf is a quiet cafe for slow bread and morning light.",
        data: createCafeBrandStoryData()
      }
    },
    {
      id: "information-architecture",
      title: "Information Architecture",
      status: "passed",
      objective: "Order the website sections around the cafe visit path.",
      output: {
        kind: "sitemap",
        summary: "Hero, menu preview, story, gallery, visit, reservations, footer.",
        data: createCafeInformationArchitectureData()
      }
    },
    {
      id: "creative-direction",
      title: "Creative Direction",
      status: "passed",
      objective: "Set the visual language before section design.",
      output: {
        kind: "style-system",
        summary: "Light-only editorial cafe direction with tactile morning details.",
        data: createCafeCreativeDirectionData()
      }
    },
    {
      id: "section-design",
      title: "Hero Section Design",
      status: "passed",
      objective: "Create the image-led hero section spec.",
      output: {
        kind: "section-spec",
        summary: "Full-bleed cafe hero with specific copy and two clear CTAs.",
        data: createCafeSectionDesignData()
      }
    },
    {
      id: "responsive-layout",
      title: "Responsive Layout",
      status: "passed",
      objective: "Define stable hero behavior across breakpoints.",
      output: {
        kind: "breakpoint-rules",
        summary: "Stack CTAs on mobile and keep text in image negative space.",
        data: createCafeResponsiveLayoutData()
      }
    },
    {
      id: "interaction-motion",
      title: "Interaction & Motion",
      status: "passed",
      objective: "Define restrained, purposeful interactions.",
      output: {
        kind: "interaction-spec",
        summary: "Subtle button states and reduced-motion-safe image treatment.",
        data: createCafeInteractionMotionData()
      }
    },
    {
      id: "accessibility-review",
      title: "Accessibility Review",
      status: "passed",
      objective: "Check accessibility expectations before design QA.",
      output: {
        kind: "accessibility-checklist",
        summary: "Hero copy, CTAs, image meaning, and contrast have acceptance rules.",
        data: createCafeAccessibilityReviewData()
      }
    },
    {
      id: "qa-review",
      title: "Design QA",
      status: "passed",
      objective: "Resolve design defects before implementation.",
      output: {
        kind: "qa-report",
        summary: "Design QA passed after confirming brand specificity and CTA layout.",
        data: {
          passNumber: 1
        }
      }
    },
    {
      id: "code-generation",
      title: "Code Generation",
      status: "passed",
      objective: "Generate the approved hero implementation.",
      output: {
        kind: "implementation-plan",
        summary: "Create CafeHero with stable responsive layout and image asset.",
        data: {
          components: ["CafeHero"]
        }
      }
    },
    {
      id: "implementation-qa",
      title: "Implementation QA",
      status: "passed",
      objective: "Verify rendered code output after implementation.",
      output: {
        kind: "runtime-qa-report",
        summary:
          "Rendered QA passed for layout, responsiveness, and content integrity.",
        data: {
          passNumber: 1
        }
      }
    },
    {
      id: "final-polish",
      title: "Final Polish",
      status: "passed",
      objective: "Confirm cohesive story and visual finish.",
      output: {
        kind: "polish-report",
        summary: "Final hero direction remains specific, warm, and light-only.",
        data: createCafeFinalPolishData()
      }
    }
  ];

  return {
    currentStep: "final-polish",
    steps,
    qa: {
      passNumber: 1,
      status: "pass",
      inspectedAt: "2026-06-22T18:30:00.000Z",
      scope: "Lumen & Loaf hero design",
      viewportResults: [
        {
          viewport: "mobile",
          status: "pass",
          evidence: "Mobile design spec stacks CTAs and keeps text readable.",
          notes: "No design defects remain for the hero spec."
        },
        {
          viewport: "desktop",
          status: "pass",
          evidence: "Desktop design spec uses image negative space for text.",
          notes: "Hero remains specific to the cafe brand."
        }
      ],
      issues: [],
      fixPlan: [],
      resolvedIssueIds: ["QA-001"],
      remainingIssueIds: [],
      stopCondition: "All design QA issues passed or were resolved.",
      nextAction: "generate-code"
    },
    codeGeneration: {
      status: "generated",
      summary: "Generated CafeHero implementation plan from approved design QA.",
      targetFiles: ["src/App.tsx", "src/styles.css"],
      components: ["CafeHero"],
      assets: ["sunlit-cafe-table.webp"],
      constraints: [
        "light-only",
        "no dark panels",
        "no card hero",
        "accessible text contrast"
      ],
      implementationNotes: [
        "Use a full-bleed image hero.",
        "Stack CTA buttons below 640px."
      ],
      acceptanceCriteria: [
        "Hero feels specific to Lumen & Loaf.",
        "Rendered mobile layout has no overlapping text or CTA collision."
      ]
    },
    implementationQa: {
      passNumber: 1,
      status: "pass",
      inspectedAt: "2026-06-22T18:35:00.000Z",
      scope: "Rendered Lumen & Loaf hero implementation",
      checks: [
        {
          id: "CHECK-001",
          kind: "rendered-layout",
          status: "pass",
          target: "hero",
          evidence: "Rendered hero keeps copy and CTAs separated.",
          notes: "No overlap detected in the reported pass."
        },
        {
          id: "CHECK-002",
          kind: "content-integrity",
          status: "pass",
          target: "hero copy",
          evidence: "Headline and CTAs match approved design copy.",
          notes: "Brand story is preserved."
        }
      ],
      issues: [],
      fixPlan: [],
      resolvedIssueIds: ["IQA-001"],
      remainingIssueIds: [],
      stopCondition: "Rendered implementation QA passed with no remaining issues.",
      nextAction: "stop-pass"
    }
  };
}

function createBuildResult(
  overrides: Partial<BuildResult> & Pick<BuildResult, "jobId" | "status">
): BuildResult {
  return {
    jobId: overrides.jobId,
    status: overrides.status,
    compiler: overrides.compiler ?? "pdflatex",
    command: overrides.command ?? ["latexmk", "-pdf", "main.tex"],
    securityPolicy: overrides.securityPolicy ?? {
      shellEscape: {
        enabled: false,
        commandFlag: "-no-shell-escape",
        approvalRequiredToEnable: true,
        agentMayEnable: false,
        message:
          "Shell escape is disabled for LaTeX builds. Enabling it requires explicit user approval."
      }
    },
    startedAt: overrides.startedAt ?? "2026-06-08T00:00:00.000Z",
    finishedAt: overrides.finishedAt ?? "2026-06-08T00:00:01.000Z",
    durationMs: overrides.durationMs ?? 1000,
    ...(overrides.exitCode === undefined ? {} : { exitCode: overrides.exitCode }),
    diagnostics: overrides.diagnostics ?? [],
    rawLog:
      overrides.rawLog ??
      (overrides.status === "succeeded" ? "Output written on main.pdf" : ""),
    ...(overrides.rawLogTruncated === undefined
      ? {}
      : { rawLogTruncated: overrides.rawLogTruncated }),
    ...(overrides.rawLogBytes === undefined
      ? {}
      : { rawLogBytes: overrides.rawLogBytes }),
    ...(overrides.rawLogOriginalBytes === undefined
      ? {}
      : { rawLogOriginalBytes: overrides.rawLogOriginalBytes }),
    stdout: overrides.stdout ?? "",
    stderr: overrides.stderr ?? "",
    ...(overrides.artifact === undefined ? {} : { artifact: overrides.artifact })
  };
}

function createBroker(
  calls: string[] = [],
  options: {
    readonly compileResults?: readonly BuildResult[];
    readonly captureResult?: PdfPreviewCaptureResult;
    readonly emittedEvents?: AgentEvent[];
    readonly readFiles?: Readonly<Record<string, string>>;
    readonly searchResults?: Readonly<
      Record<string, readonly { readonly path: string; readonly contents: string }[]>
    >;
  } = {}
): CodexCliToolBroker {
  let compileRunCount = 0;
  let proposedPatchCount = 0;

  return {
    emitEvent: (event) => {
      options.emittedEvents?.push(event);
    },
    readFile: (path) => {
      calls.push(`read-file:${path}`);
      return Promise.resolve({
        path,
        contents:
          options.readFiles?.[path] ??
          "\\documentclass{article}\n\\begin{document}\nHello\n",
        mtimeMs: 1
      });
    },
    searchProject: (query) => {
      calls.push(`search-project:${query}`);
      return Promise.resolve(
        (options.searchResults?.[query] ?? []).map((result) => ({
          path: result.path,
          contents: result.contents,
          mtimeMs: 1
        }))
      );
    },
    capturePdfPreview: () => {
      calls.push("capture-pdf-preview");
      return Promise.resolve(
        options.captureResult ?? {
          projectRoot: "/tmp/project",
          imagePath: "/tmp/project/.latex-agent/visual-captures/pdf-preview.png",
          mimeType: "image/png",
          byteLength: 4096,
          width: 640,
          height: 900,
          pageNumber: 1,
          pageCount: 2,
          stale: false,
          pdfPath: "/tmp/project/.latex-agent/build/main.pdf",
          capturedAt: "2026-06-17T00:00:00.000Z"
        }
      );
    },
    setMainFile: (path) => {
      calls.push(`set-main-file:${path}`);
      return Promise.resolve({ path });
    },
    moveEntry: (fromPath, toPath) => {
      calls.push(`move-entry:${fromPath}->${toPath}`);
      return Promise.resolve({ fromPath, toPath });
    },
    deleteEntry: (path) => {
      calls.push(`delete-entry:${path}`);
      return Promise.resolve({ path });
    },
    runCompile: () => {
      calls.push("run-compile");
      const result =
        options.compileResults?.[
          Math.min(compileRunCount, options.compileResults.length - 1)
        ] ?? createBuildResult({ jobId: "build-1", status: "succeeded" });
      compileRunCount += 1;
      return Promise.resolve(result);
    },
    proposePatch: (filePath, _beforeContents, afterContents, summary) => {
      proposedPatchCount += 1;
      calls.push("propose-patch");
      return Promise.resolve({
        id: `changeset-${proposedPatchCount}`,
        projectRoot: "/tmp/project",
        filePath,
        summary,
        patch: afterContents,
        status: "proposed",
        baseSnapshotId: `snapshot-${proposedPatchCount}`,
        createdAt: "2026-06-08T00:00:00.000Z",
        updatedAt: "2026-06-08T00:00:00.000Z"
      });
    },
    applyPatch: (changesetId) => {
      calls.push(`apply-patch:${changesetId}`);
      return Promise.resolve({
        id: changesetId,
        projectRoot: "/tmp/project",
        filePath: "main.tex",
        summary: "Add missing document end",
        patch: "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n",
        status: "applied",
        baseSnapshotId: "snapshot-1",
        createdAt: "2026-06-08T00:00:00.000Z",
        updatedAt: "2026-06-08T00:00:01.000Z"
      });
    }
  };
}
