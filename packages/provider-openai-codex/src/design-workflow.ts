export const designWorkflowStepIds = [
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
] as const;

export type DesignWorkflowStepId = (typeof designWorkflowStepIds)[number];

export const designWorkflowOutputKinds = [
  "none",
  "brief",
  "sitemap",
  "style-system",
  "section-spec",
  "breakpoint-rules",
  "interaction-spec",
  "accessibility-checklist",
  "qa-report",
  "implementation-plan",
  "runtime-qa-report",
  "polish-report"
] as const;

export type DesignWorkflowOutputKind = (typeof designWorkflowOutputKinds)[number];

export const designWorkflowStepStatuses = [
  "not-started",
  "in-progress",
  "ready-for-review",
  "needs-revision",
  "passed",
  "blocked"
] as const;

export type DesignWorkflowStepStatus = (typeof designWorkflowStepStatuses)[number];

export const designQaIssueCategories = [
  "visual-layout",
  "responsive",
  "content-quality",
  "accessibility",
  "interaction",
  "brand-story",
  "performance"
] as const;

export type DesignQaIssueCategory = (typeof designQaIssueCategories)[number];

export const designQaSeverities = ["blocker", "high", "medium", "low"] as const;

export type DesignQaSeverity = (typeof designQaSeverities)[number];

export const designQaEvidenceKinds = [
  "screenshot",
  "viewport-check",
  "accessibility-check",
  "performance-check",
  "source-review",
  "manual-inspection"
] as const;

export type DesignQaEvidenceKind = (typeof designQaEvidenceKinds)[number];

export const designQaViewports = [
  "mobile",
  "tablet",
  "desktop",
  "wide-desktop"
] as const;

export type DesignQaViewport = (typeof designQaViewports)[number];

export const designQaViewportStatuses = [
  "pass",
  "issues-found",
  "not-checked"
] as const;

export type DesignQaViewportStatus = (typeof designQaViewportStatuses)[number];

export const designQaIssueStatuses = ["open", "resolved", "accepted"] as const;

export type DesignQaIssueStatus = (typeof designQaIssueStatuses)[number];

export const designQaFixActionTypes = [
  "revise-copy",
  "adjust-layout",
  "adjust-visuals",
  "adjust-responsive-rules",
  "adjust-interaction",
  "fix-accessibility",
  "optimize-performance"
] as const;

export type DesignQaFixActionType = (typeof designQaFixActionTypes)[number];

export const designQaStepStatuses = ["pass", "needs-revision", "blocked"] as const;

export type DesignQaStepStatus = (typeof designQaStepStatuses)[number];

export const designQaNextActions = [
  "apply-fixes",
  "generate-code",
  "run-implementation-qa",
  "request-review",
  "stop-pass",
  "blocked"
] as const;

export type DesignQaNextAction = (typeof designQaNextActions)[number];

export const designCodeGenerationStatuses = [
  "not-started",
  "ready-for-review",
  "generated",
  "blocked"
] as const;

export type DesignCodeGenerationStatus = (typeof designCodeGenerationStatuses)[number];

export const implementationQaStatuses = [
  "not-run",
  "pass",
  "needs-revision",
  "blocked"
] as const;

export type ImplementationQaStatus = (typeof implementationQaStatuses)[number];

export const implementationQaCheckKinds = [
  "rendered-layout",
  "responsive",
  "accessibility",
  "interaction",
  "performance",
  "content-integrity",
  "build"
] as const;

export type ImplementationQaCheckKind = (typeof implementationQaCheckKinds)[number];

export type DesignWorkflowStepOutput = {
  readonly kind: DesignWorkflowOutputKind;
  readonly summary: string;
  readonly data: Record<string, unknown>;
};

export type DesignWorkflowStep = {
  readonly id: DesignWorkflowStepId;
  readonly title: string;
  readonly status: DesignWorkflowStepStatus;
  readonly objective: string;
  readonly output: DesignWorkflowStepOutput;
};

export type DesignQaViewportResult = {
  readonly viewport: DesignQaViewport;
  readonly status: DesignQaViewportStatus;
  readonly evidence: string;
  readonly notes: string;
};

export type DesignQaIssue = {
  readonly id: string;
  readonly category: DesignQaIssueCategory;
  readonly severity: DesignQaSeverity;
  readonly location: string;
  readonly problem: string;
  readonly evidenceKind: DesignQaEvidenceKind;
  readonly evidence: string;
  readonly recommendedFix: string;
  readonly status: DesignQaIssueStatus;
};

export type DesignQaFixAction = {
  readonly id: string;
  readonly issueIds: readonly string[];
  readonly action: DesignQaFixActionType;
  readonly targetSection: string;
  readonly description: string;
  readonly expectedOutcome: string;
  readonly requiresPatch: boolean;
};

export type DesignQaStepOutput = {
  readonly passNumber: number;
  readonly status: DesignQaStepStatus;
  readonly inspectedAt: string;
  readonly scope: string;
  readonly viewportResults: readonly DesignQaViewportResult[];
  readonly issues: readonly DesignQaIssue[];
  readonly fixPlan: readonly DesignQaFixAction[];
  readonly resolvedIssueIds: readonly string[];
  readonly remainingIssueIds: readonly string[];
  readonly stopCondition: string;
  readonly nextAction: DesignQaNextAction;
};

export type DesignCodeGenerationOutput = {
  readonly status: DesignCodeGenerationStatus;
  readonly summary: string;
  readonly targetFiles: readonly string[];
  readonly components: readonly string[];
  readonly assets: readonly string[];
  readonly constraints: readonly string[];
  readonly implementationNotes: readonly string[];
  readonly acceptanceCriteria: readonly string[];
};

export type ImplementationQaCheck = {
  readonly id: string;
  readonly kind: ImplementationQaCheckKind;
  readonly status: DesignQaViewportStatus;
  readonly target: string;
  readonly evidence: string;
  readonly notes: string;
};

export type ImplementationQaOutput = {
  readonly passNumber: number;
  readonly status: ImplementationQaStatus;
  readonly inspectedAt: string;
  readonly scope: string;
  readonly checks: readonly ImplementationQaCheck[];
  readonly issues: readonly DesignQaIssue[];
  readonly fixPlan: readonly DesignQaFixAction[];
  readonly resolvedIssueIds: readonly string[];
  readonly remainingIssueIds: readonly string[];
  readonly stopCondition: string;
  readonly nextAction: DesignQaNextAction;
};

export type BrandStoryData = {
  readonly brandName: string;
  readonly businessType: string;
  readonly positioning: string;
  readonly audience: readonly string[];
  readonly brandPromise: string;
  readonly mood: readonly string[];
  readonly storyPremise: string;
  readonly sensoryAnchors: readonly string[];
  readonly toneOfVoice: {
    readonly personality: readonly string[];
    readonly copyRules: readonly string[];
  };
  readonly differentiators: readonly string[];
  readonly antiPatterns: readonly string[];
};

export type InformationArchitectureSection = {
  readonly id: string;
  readonly title: string;
  readonly purpose: string;
  readonly storyRole: string;
  readonly primaryContent: readonly string[];
  readonly cta: string;
  readonly requiredEvidence: readonly string[];
};

export type InformationArchitectureUserPath = {
  readonly id: string;
  readonly audience: string;
  readonly intent: string;
  readonly steps: readonly string[];
  readonly conversionGoal: string;
};

export type InformationArchitectureCtaPriority = {
  readonly rank: number;
  readonly label: string;
  readonly targetSection: string;
  readonly intent: string;
};

export type InformationArchitectureNavigationModel = {
  readonly type: string;
  readonly primaryItems: readonly string[];
  readonly secondaryItems: readonly string[];
  readonly mobileBehavior: string;
  readonly stickyBehavior: string;
};

export type InformationArchitectureCreativeDirectionHandoff = {
  readonly nextStepFocus: readonly string[];
  readonly visualQuestions: readonly string[];
  readonly contentRisks: readonly string[];
};

export type InformationArchitectureData = {
  readonly websiteStoryArc: readonly string[];
  readonly sectionsDetailed: readonly InformationArchitectureSection[];
  readonly sectionOrder: readonly string[];
  readonly primaryUserPaths: readonly InformationArchitectureUserPath[];
  readonly ctaPriority: readonly InformationArchitectureCtaPriority[];
  readonly navigationModel: InformationArchitectureNavigationModel;
  readonly contentRequirements: readonly string[];
  readonly handoffToCreativeDirection: InformationArchitectureCreativeDirectionHandoff;
};

export type CreativeDirectionColor = {
  readonly name: string;
  readonly value: string;
  readonly role: string;
  readonly usage: readonly string[];
};

export type CreativeDirectionTypographySystem = {
  readonly heading: string;
  readonly body: string;
  readonly navigation: string;
  readonly scale: readonly string[];
  readonly rules: readonly string[];
};

export type CreativeDirectionImageDirection = {
  readonly subjects: readonly string[];
  readonly lighting: string;
  readonly framing: readonly string[];
  readonly avoid: readonly string[];
};

export type CreativeDirectionCtaSystem = {
  readonly primary: string;
  readonly secondary: string;
  readonly focus: string;
  readonly rules: readonly string[];
};

export type CreativeDirectionMotionMood = {
  readonly principles: readonly string[];
  readonly hover: string;
  readonly transitions: string;
  readonly reducedMotion: string;
};

export type CreativeDirectionSectionProgression = {
  readonly sectionId: string;
  readonly visualRole: string;
  readonly treatment: string;
};

export type CreativeDirectionHandoffToSectionDesign = {
  readonly prioritySections: readonly string[];
  readonly layoutQuestions: readonly string[];
  readonly assetRequests: readonly string[];
  readonly risks: readonly string[];
};

export type CreativeDirectionData = {
  readonly colorSystem: readonly CreativeDirectionColor[];
  readonly typographySystem: CreativeDirectionTypographySystem;
  readonly imageDirection: CreativeDirectionImageDirection;
  readonly compositionPrinciples: readonly string[];
  readonly spacingRhythm: readonly string[];
  readonly textureMaterialRules: readonly string[];
  readonly iconIllustrationRules: readonly string[];
  readonly ctaSystem: CreativeDirectionCtaSystem;
  readonly motionMood: CreativeDirectionMotionMood;
  readonly sectionProgression: readonly CreativeDirectionSectionProgression[];
  readonly handoffToSectionDesign: CreativeDirectionHandoffToSectionDesign;
};

export type SectionDesignSpec = {
  readonly id: string;
  readonly storyRole: string;
  readonly layout: string;
  readonly elements: readonly string[];
  readonly visualAssets: readonly string[];
  readonly assetPlacement: string;
  readonly ctas: readonly string[];
  readonly responsiveNotes: readonly string[];
  readonly acceptanceCriteria: readonly string[];
};

export type ResponsiveRule = {
  readonly viewport: string;
  readonly layout: string;
  readonly typography: string;
  readonly navigation: string;
  readonly assets: string;
  readonly constraints: readonly string[];
};

export type InteractionRule = {
  readonly trigger: string;
  readonly target: string;
  readonly feedback: string;
  readonly motion: string;
  readonly accessibility: string;
  readonly reducedMotion: string;
};

export type AccessibilityDesignCheck = {
  readonly id: string;
  readonly target: string;
  readonly requirement: string;
  readonly method: string;
  readonly status: string;
  readonly fix: string;
};

export type PolishCheck = {
  readonly target: string;
  readonly criterion: string;
  readonly status: string;
  readonly recommendation: string;
};

export type DesignWorkflowOutput = {
  readonly currentStep: DesignWorkflowStepId | "none";
  readonly steps: readonly DesignWorkflowStep[];
  readonly qa: DesignQaStepOutput;
  readonly codeGeneration: DesignCodeGenerationOutput;
  readonly implementationQa: ImplementationQaOutput;
};

export function createEmptyDesignWorkflowOutput(): DesignWorkflowOutput {
  return {
    currentStep: "none",
    steps: [],
    qa: {
      passNumber: 0,
      status: "blocked",
      inspectedAt: "",
      scope: "",
      viewportResults: [],
      issues: [],
      fixPlan: [],
      resolvedIssueIds: [],
      remainingIssueIds: [],
      stopCondition: "No website or design QA workflow was requested.",
      nextAction: "blocked"
    },
    codeGeneration: {
      status: "not-started",
      summary: "",
      targetFiles: [],
      components: [],
      assets: [],
      constraints: [],
      implementationNotes: [],
      acceptanceCriteria: []
    },
    implementationQa: {
      passNumber: 0,
      status: "not-run",
      inspectedAt: "",
      scope: "",
      checks: [],
      issues: [],
      fixPlan: [],
      resolvedIssueIds: [],
      remainingIssueIds: [],
      stopCondition: "No generated website implementation was available to inspect.",
      nextAction: "blocked"
    }
  };
}

export function isValidDesignWorkflowOutput(
  value: unknown
): value is DesignWorkflowOutput {
  if (!isRecord(value)) {
    return false;
  }

  if (
    !(
      isEnumValue(value.currentStep, [...designWorkflowStepIds, "none"]) &&
      Array.isArray(value.steps) &&
      value.steps.every(isValidDesignWorkflowStep) &&
      isValidDesignQaStepOutput(value.qa) &&
      isValidDesignCodeGenerationOutput(value.codeGeneration) &&
      isValidImplementationQaOutput(value.implementationQa)
    )
  ) {
    return false;
  }

  const stepIds = new Set(
    value.steps.map((step) => (isRecord(step) ? step.id : undefined))
  );

  return (
    (!stepIds.has("qa-review") || isCompleteDesignQaStepOutput(value.qa)) &&
    (!stepIds.has("code-generation") ||
      isCompleteDesignCodeGenerationOutput(value.codeGeneration)) &&
    (!stepIds.has("implementation-qa") ||
      isCompleteImplementationQaOutput(value.implementationQa))
  );
}

const designWorkflowStepDataSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    brandName: { type: "string" },
    businessType: { type: "string" },
    positioning: { type: "string" },
    audience: {
      type: "array",
      items: { type: "string" }
    },
    brandPromise: { type: "string" },
    mood: {
      type: "array",
      items: { type: "string" }
    },
    storyPremise: { type: "string" },
    sensoryAnchors: {
      type: "array",
      items: { type: "string" }
    },
    toneOfVoice: {
      type: "object",
      additionalProperties: false,
      properties: {
        personality: {
          type: "array",
          items: { type: "string" }
        },
        copyRules: {
          type: "array",
          items: { type: "string" }
        }
      },
      required: ["personality", "copyRules"]
    },
    differentiators: {
      type: "array",
      items: { type: "string" }
    },
    antiPatterns: {
      type: "array",
      items: { type: "string" }
    },
    sections: {
      type: "array",
      items: { type: "string" }
    },
    palette: {
      type: "array",
      items: { type: "string" }
    },
    photography: { type: "string" },
    section: { type: "string" },
    headline: { type: "string" },
    primaryCta: { type: "string" },
    secondaryCta: { type: "string" },
    breakpoints: {
      type: "array",
      items: { type: "string" }
    },
    hover: { type: "string" },
    reducedMotion: { type: "string" },
    contrast: { type: "string" },
    tapTargets: { type: "string" },
    passNumber: { type: "number" },
    components: {
      type: "array",
      items: { type: "string" }
    },
    acceptedRisks: {
      type: "array",
      items: { type: "string" }
    },
    websiteStoryArc: {
      type: "array",
      items: { type: "string" }
    },
    sectionsDetailed: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          purpose: { type: "string" },
          storyRole: { type: "string" },
          primaryContent: {
            type: "array",
            items: { type: "string" }
          },
          cta: { type: "string" },
          requiredEvidence: {
            type: "array",
            items: { type: "string" }
          }
        },
        required: [
          "id",
          "title",
          "purpose",
          "storyRole",
          "primaryContent",
          "cta",
          "requiredEvidence"
        ]
      }
    },
    sectionOrder: {
      type: "array",
      items: { type: "string" }
    },
    primaryUserPaths: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          audience: { type: "string" },
          intent: { type: "string" },
          steps: {
            type: "array",
            items: { type: "string" }
          },
          conversionGoal: { type: "string" }
        },
        required: ["id", "audience", "intent", "steps", "conversionGoal"]
      }
    },
    ctaPriority: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          rank: { type: "number" },
          label: { type: "string" },
          targetSection: { type: "string" },
          intent: { type: "string" }
        },
        required: ["rank", "label", "targetSection", "intent"]
      }
    },
    navigationModel: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { type: "string" },
        primaryItems: {
          type: "array",
          items: { type: "string" }
        },
        secondaryItems: {
          type: "array",
          items: { type: "string" }
        },
        mobileBehavior: { type: "string" },
        stickyBehavior: { type: "string" }
      },
      required: [
        "type",
        "primaryItems",
        "secondaryItems",
        "mobileBehavior",
        "stickyBehavior"
      ]
    },
    contentRequirements: {
      type: "array",
      items: { type: "string" }
    },
    handoffToCreativeDirection: {
      type: "object",
      additionalProperties: false,
      properties: {
        nextStepFocus: {
          type: "array",
          items: { type: "string" }
        },
        visualQuestions: {
          type: "array",
          items: { type: "string" }
        },
        contentRisks: {
          type: "array",
          items: { type: "string" }
        }
      },
      required: ["nextStepFocus", "visualQuestions", "contentRisks"]
    },
    colorSystem: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          value: { type: "string" },
          role: { type: "string" },
          usage: {
            type: "array",
            items: { type: "string" }
          }
        },
        required: ["name", "value", "role", "usage"]
      }
    },
    typographySystem: {
      type: "object",
      additionalProperties: false,
      properties: {
        heading: { type: "string" },
        body: { type: "string" },
        navigation: { type: "string" },
        scale: {
          type: "array",
          items: { type: "string" }
        },
        rules: {
          type: "array",
          items: { type: "string" }
        }
      },
      required: ["heading", "body", "navigation", "scale", "rules"]
    },
    imageDirection: {
      type: "object",
      additionalProperties: false,
      properties: {
        subjects: {
          type: "array",
          items: { type: "string" }
        },
        lighting: { type: "string" },
        framing: {
          type: "array",
          items: { type: "string" }
        },
        avoid: {
          type: "array",
          items: { type: "string" }
        }
      },
      required: ["subjects", "lighting", "framing", "avoid"]
    },
    compositionPrinciples: {
      type: "array",
      items: { type: "string" }
    },
    spacingRhythm: {
      type: "array",
      items: { type: "string" }
    },
    textureMaterialRules: {
      type: "array",
      items: { type: "string" }
    },
    iconIllustrationRules: {
      type: "array",
      items: { type: "string" }
    },
    ctaSystem: {
      type: "object",
      additionalProperties: false,
      properties: {
        primary: { type: "string" },
        secondary: { type: "string" },
        focus: { type: "string" },
        rules: {
          type: "array",
          items: { type: "string" }
        }
      },
      required: ["primary", "secondary", "focus", "rules"]
    },
    motionMood: {
      type: "object",
      additionalProperties: false,
      properties: {
        principles: {
          type: "array",
          items: { type: "string" }
        },
        hover: { type: "string" },
        transitions: { type: "string" },
        reducedMotion: { type: "string" }
      },
      required: ["principles", "hover", "transitions", "reducedMotion"]
    },
    sectionProgression: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          sectionId: { type: "string" },
          visualRole: { type: "string" },
          treatment: { type: "string" }
        },
        required: ["sectionId", "visualRole", "treatment"]
      }
    },
    handoffToSectionDesign: {
      type: "object",
      additionalProperties: false,
      properties: {
        prioritySections: {
          type: "array",
          items: { type: "string" }
        },
        layoutQuestions: {
          type: "array",
          items: { type: "string" }
        },
        assetRequests: {
          type: "array",
          items: { type: "string" }
        },
        risks: {
          type: "array",
          items: { type: "string" }
        }
      },
      required: ["prioritySections", "layoutQuestions", "assetRequests", "risks"]
    },
    sectionDesigns: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          storyRole: { type: "string" },
          layout: { type: "string" },
          elements: {
            type: "array",
            items: { type: "string" }
          },
          visualAssets: {
            type: "array",
            items: { type: "string" }
          },
          assetPlacement: { type: "string" },
          ctas: {
            type: "array",
            items: { type: "string" }
          },
          responsiveNotes: {
            type: "array",
            items: { type: "string" }
          },
          acceptanceCriteria: {
            type: "array",
            items: { type: "string" }
          }
        },
        required: [
          "id",
          "storyRole",
          "layout",
          "elements",
          "visualAssets",
          "assetPlacement",
          "ctas",
          "responsiveNotes",
          "acceptanceCriteria"
        ]
      }
    },
    responsiveRules: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          viewport: { type: "string" },
          layout: { type: "string" },
          typography: { type: "string" },
          navigation: { type: "string" },
          assets: { type: "string" },
          constraints: {
            type: "array",
            items: { type: "string" }
          }
        },
        required: [
          "viewport",
          "layout",
          "typography",
          "navigation",
          "assets",
          "constraints"
        ]
      }
    },
    interactionRules: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          trigger: { type: "string" },
          target: { type: "string" },
          feedback: { type: "string" },
          motion: { type: "string" },
          accessibility: { type: "string" },
          reducedMotion: { type: "string" }
        },
        required: [
          "trigger",
          "target",
          "feedback",
          "motion",
          "accessibility",
          "reducedMotion"
        ]
      }
    },
    accessibilityChecks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          target: { type: "string" },
          requirement: { type: "string" },
          method: { type: "string" },
          status: { type: "string" },
          fix: { type: "string" }
        },
        required: ["id", "target", "requirement", "method", "status", "fix"]
      }
    },
    polishChecks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          target: { type: "string" },
          criterion: { type: "string" },
          status: { type: "string" },
          recommendation: { type: "string" }
        },
        required: ["target", "criterion", "status", "recommendation"]
      }
    }
  },
  required: [
    "brandName",
    "businessType",
    "positioning",
    "audience",
    "brandPromise",
    "mood",
    "storyPremise",
    "sensoryAnchors",
    "toneOfVoice",
    "differentiators",
    "antiPatterns",
    "sections",
    "palette",
    "photography",
    "section",
    "headline",
    "primaryCta",
    "secondaryCta",
    "breakpoints",
    "hover",
    "reducedMotion",
    "contrast",
    "tapTargets",
    "passNumber",
    "components",
    "acceptedRisks",
    "websiteStoryArc",
    "sectionsDetailed",
    "sectionOrder",
    "primaryUserPaths",
    "ctaPriority",
    "navigationModel",
    "contentRequirements",
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
    "handoffToSectionDesign",
    "sectionDesigns",
    "responsiveRules",
    "interactionRules",
    "accessibilityChecks",
    "polishChecks"
  ]
} as const;

export const designWorkflowOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    currentStep: { enum: [...designWorkflowStepIds, "none"] },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { enum: designWorkflowStepIds },
          title: { type: "string" },
          status: { enum: designWorkflowStepStatuses },
          objective: { type: "string" },
          output: {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { enum: designWorkflowOutputKinds },
              summary: { type: "string" },
              data: designWorkflowStepDataSchema
            },
            required: ["kind", "summary", "data"]
          }
        },
        required: ["id", "title", "status", "objective", "output"]
      }
    },
    qa: {
      type: "object",
      additionalProperties: false,
      properties: {
        passNumber: { type: "number" },
        status: { enum: designQaStepStatuses },
        inspectedAt: { type: "string" },
        scope: { type: "string" },
        viewportResults: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              viewport: { enum: designQaViewports },
              status: { enum: designQaViewportStatuses },
              evidence: { type: "string" },
              notes: { type: "string" }
            },
            required: ["viewport", "status", "evidence", "notes"]
          }
        },
        issues: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              category: { enum: designQaIssueCategories },
              severity: { enum: designQaSeverities },
              location: { type: "string" },
              problem: { type: "string" },
              evidenceKind: { enum: designQaEvidenceKinds },
              evidence: { type: "string" },
              recommendedFix: { type: "string" },
              status: { enum: designQaIssueStatuses }
            },
            required: [
              "id",
              "category",
              "severity",
              "location",
              "problem",
              "evidenceKind",
              "evidence",
              "recommendedFix",
              "status"
            ]
          }
        },
        fixPlan: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              issueIds: {
                type: "array",
                items: { type: "string" }
              },
              action: { enum: designQaFixActionTypes },
              targetSection: { type: "string" },
              description: { type: "string" },
              expectedOutcome: { type: "string" },
              requiresPatch: { type: "boolean" }
            },
            required: [
              "id",
              "issueIds",
              "action",
              "targetSection",
              "description",
              "expectedOutcome",
              "requiresPatch"
            ]
          }
        },
        resolvedIssueIds: {
          type: "array",
          items: { type: "string" }
        },
        remainingIssueIds: {
          type: "array",
          items: { type: "string" }
        },
        stopCondition: { type: "string" },
        nextAction: { enum: designQaNextActions }
      },
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
    },
    codeGeneration: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: { enum: designCodeGenerationStatuses },
        summary: { type: "string" },
        targetFiles: {
          type: "array",
          items: { type: "string" }
        },
        components: {
          type: "array",
          items: { type: "string" }
        },
        assets: {
          type: "array",
          items: { type: "string" }
        },
        constraints: {
          type: "array",
          items: { type: "string" }
        },
        implementationNotes: {
          type: "array",
          items: { type: "string" }
        },
        acceptanceCriteria: {
          type: "array",
          items: { type: "string" }
        }
      },
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
    },
    implementationQa: {
      type: "object",
      additionalProperties: false,
      properties: {
        passNumber: { type: "number" },
        status: { enum: implementationQaStatuses },
        inspectedAt: { type: "string" },
        scope: { type: "string" },
        checks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              kind: { enum: implementationQaCheckKinds },
              status: { enum: designQaViewportStatuses },
              target: { type: "string" },
              evidence: { type: "string" },
              notes: { type: "string" }
            },
            required: ["id", "kind", "status", "target", "evidence", "notes"]
          }
        },
        issues: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              category: { enum: designQaIssueCategories },
              severity: { enum: designQaSeverities },
              location: { type: "string" },
              problem: { type: "string" },
              evidenceKind: { enum: designQaEvidenceKinds },
              evidence: { type: "string" },
              recommendedFix: { type: "string" },
              status: { enum: designQaIssueStatuses }
            },
            required: [
              "id",
              "category",
              "severity",
              "location",
              "problem",
              "evidenceKind",
              "evidence",
              "recommendedFix",
              "status"
            ]
          }
        },
        fixPlan: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              issueIds: {
                type: "array",
                items: { type: "string" }
              },
              action: { enum: designQaFixActionTypes },
              targetSection: { type: "string" },
              description: { type: "string" },
              expectedOutcome: { type: "string" },
              requiresPatch: { type: "boolean" }
            },
            required: [
              "id",
              "issueIds",
              "action",
              "targetSection",
              "description",
              "expectedOutcome",
              "requiresPatch"
            ]
          }
        },
        resolvedIssueIds: {
          type: "array",
          items: { type: "string" }
        },
        remainingIssueIds: {
          type: "array",
          items: { type: "string" }
        },
        stopCondition: { type: "string" },
        nextAction: { enum: designQaNextActions }
      },
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
    }
  },
  required: ["currentStep", "steps", "qa", "codeGeneration", "implementationQa"]
} as const;

function isValidDesignWorkflowStep(value: unknown): value is DesignWorkflowStep {
  if (!isRecord(value) || !isRecord(value.output)) {
    return false;
  }

  return (
    isEnumValue(value.id, designWorkflowStepIds) &&
    typeof value.title === "string" &&
    isEnumValue(value.status, designWorkflowStepStatuses) &&
    typeof value.objective === "string" &&
    isEnumValue(value.output.kind, designWorkflowOutputKinds) &&
    typeof value.output.summary === "string" &&
    isRecord(value.output.data) &&
    (value.id !== "brand-story" || isValidBrandStoryData(value.output.data)) &&
    (value.id !== "information-architecture" ||
      isValidInformationArchitectureData(value.output.data)) &&
    (value.id !== "creative-direction" ||
      isValidCreativeDirectionData(value.output.data)) &&
    (value.id !== "section-design" || isValidSectionDesignData(value.output.data)) &&
    (value.id !== "responsive-layout" ||
      isValidResponsiveLayoutData(value.output.data)) &&
    (value.id !== "interaction-motion" ||
      isValidInteractionMotionData(value.output.data)) &&
    (value.id !== "accessibility-review" ||
      isValidAccessibilityReviewData(value.output.data)) &&
    (value.id !== "final-polish" || isValidFinalPolishData(value.output.data))
  );
}

export function isValidBrandStoryData(value: unknown): value is BrandStoryData {
  if (!isRecord(value) || !isRecord(value.toneOfVoice)) {
    return false;
  }

  return (
    hasNonEmptyString(value, "brandName") &&
    hasNonEmptyString(value, "businessType") &&
    hasNonEmptyString(value, "positioning") &&
    hasNonEmptyStringArray(value, "audience") &&
    hasNonEmptyString(value, "brandPromise") &&
    hasNonEmptyStringArray(value, "mood") &&
    hasNonEmptyString(value, "storyPremise") &&
    hasNonEmptyStringArray(value, "sensoryAnchors") &&
    hasNonEmptyStringArray(value.toneOfVoice, "personality") &&
    hasNonEmptyStringArray(value.toneOfVoice, "copyRules") &&
    hasNonEmptyStringArray(value, "differentiators") &&
    hasNonEmptyStringArray(value, "antiPatterns")
  );
}

export function isValidInformationArchitectureData(
  value: unknown
): value is InformationArchitectureData {
  if (
    !isRecord(value) ||
    !isRecord(value.navigationModel) ||
    !isRecord(value.handoffToCreativeDirection)
  ) {
    return false;
  }

  const sectionsDetailed = value.sectionsDetailed;
  const sectionOrder = value.sectionOrder;
  const primaryUserPaths = value.primaryUserPaths;
  const ctaPriority = value.ctaPriority;

  if (
    !hasNonEmptyStringArray(value, "websiteStoryArc") ||
    !Array.isArray(sectionsDetailed) ||
    sectionsDetailed.length === 0 ||
    !sectionsDetailed.every(isValidInformationArchitectureSection) ||
    !hasNonEmptyStringArray(value, "sectionOrder") ||
    !Array.isArray(primaryUserPaths) ||
    primaryUserPaths.length === 0 ||
    !primaryUserPaths.every(isValidInformationArchitectureUserPath) ||
    !Array.isArray(ctaPriority) ||
    ctaPriority.length === 0 ||
    !ctaPriority.every(isValidInformationArchitectureCtaPriority) ||
    !isValidInformationArchitectureNavigationModel(value.navigationModel) ||
    !hasNonEmptyStringArray(value, "contentRequirements") ||
    !isValidInformationArchitectureCreativeDirectionHandoff(
      value.handoffToCreativeDirection
    )
  ) {
    return false;
  }

  return hasConsistentInformationArchitectureReferences({
    sectionsDetailed: sectionsDetailed as readonly InformationArchitectureSection[],
    sectionOrder: sectionOrder as readonly string[],
    primaryUserPaths: primaryUserPaths as readonly InformationArchitectureUserPath[],
    ctaPriority: ctaPriority as readonly InformationArchitectureCtaPriority[]
  });
}

function hasConsistentInformationArchitectureReferences(data: {
  readonly sectionsDetailed: readonly InformationArchitectureSection[];
  readonly sectionOrder: readonly string[];
  readonly primaryUserPaths: readonly InformationArchitectureUserPath[];
  readonly ctaPriority: readonly InformationArchitectureCtaPriority[];
}): boolean {
  const detailedIds = data.sectionsDetailed.map((section) => section.id);
  const detailedIdSet = new Set(detailedIds);
  const orderedIdSet = new Set(data.sectionOrder);

  if (
    detailedIdSet.size !== detailedIds.length ||
    orderedIdSet.size !== data.sectionOrder.length ||
    detailedIdSet.size !== orderedIdSet.size
  ) {
    return false;
  }

  if (
    data.sectionOrder.some((sectionId) => !detailedIdSet.has(sectionId)) ||
    detailedIds.some((sectionId) => !orderedIdSet.has(sectionId))
  ) {
    return false;
  }

  return (
    data.primaryUserPaths.every((path) =>
      path.steps.every((sectionId) => orderedIdSet.has(sectionId))
    ) && data.ctaPriority.every((cta) => orderedIdSet.has(cta.targetSection))
  );
}

function isValidInformationArchitectureSection(
  value: unknown
): value is InformationArchitectureSection {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasNonEmptyString(value, "id") &&
    hasNonEmptyString(value, "title") &&
    hasNonEmptyString(value, "purpose") &&
    hasNonEmptyString(value, "storyRole") &&
    hasNonEmptyStringArray(value, "primaryContent") &&
    hasNonEmptyString(value, "cta") &&
    hasNonEmptyStringArray(value, "requiredEvidence")
  );
}

function isValidInformationArchitectureUserPath(
  value: unknown
): value is InformationArchitectureUserPath {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasNonEmptyString(value, "id") &&
    hasNonEmptyString(value, "audience") &&
    hasNonEmptyString(value, "intent") &&
    hasNonEmptyStringArray(value, "steps") &&
    hasNonEmptyString(value, "conversionGoal")
  );
}

function isValidInformationArchitectureCtaPriority(
  value: unknown
): value is InformationArchitectureCtaPriority {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.rank === "number" &&
    hasNonEmptyString(value, "label") &&
    hasNonEmptyString(value, "targetSection") &&
    hasNonEmptyString(value, "intent")
  );
}

function isValidInformationArchitectureNavigationModel(
  value: unknown
): value is InformationArchitectureNavigationModel {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasNonEmptyString(value, "type") &&
    hasNonEmptyStringArray(value, "primaryItems") &&
    isStringArray(value.secondaryItems) &&
    hasNonEmptyString(value, "mobileBehavior") &&
    hasNonEmptyString(value, "stickyBehavior")
  );
}

function isValidInformationArchitectureCreativeDirectionHandoff(
  value: unknown
): value is InformationArchitectureCreativeDirectionHandoff {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasNonEmptyStringArray(value, "nextStepFocus") &&
    hasNonEmptyStringArray(value, "visualQuestions") &&
    hasNonEmptyStringArray(value, "contentRisks")
  );
}

export function isValidCreativeDirectionData(
  value: unknown
): value is CreativeDirectionData {
  if (
    !isRecord(value) ||
    !isRecord(value.typographySystem) ||
    !isRecord(value.imageDirection) ||
    !isRecord(value.ctaSystem) ||
    !isRecord(value.motionMood) ||
    !isRecord(value.handoffToSectionDesign)
  ) {
    return false;
  }

  return (
    Array.isArray(value.colorSystem) &&
    value.colorSystem.length > 0 &&
    value.colorSystem.every(isValidCreativeDirectionColor) &&
    isValidCreativeDirectionTypographySystem(value.typographySystem) &&
    isValidCreativeDirectionImageDirection(value.imageDirection) &&
    hasNonEmptyStringArray(value, "compositionPrinciples") &&
    hasNonEmptyStringArray(value, "spacingRhythm") &&
    hasNonEmptyStringArray(value, "textureMaterialRules") &&
    hasNonEmptyStringArray(value, "iconIllustrationRules") &&
    isValidCreativeDirectionCtaSystem(value.ctaSystem) &&
    isValidCreativeDirectionMotionMood(value.motionMood) &&
    Array.isArray(value.sectionProgression) &&
    value.sectionProgression.length > 0 &&
    value.sectionProgression.every(isValidCreativeDirectionSectionProgression) &&
    isValidCreativeDirectionHandoffToSectionDesign(value.handoffToSectionDesign)
  );
}

function isValidCreativeDirectionColor(
  value: unknown
): value is CreativeDirectionColor {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasNonEmptyString(value, "name") &&
    hasNonEmptyString(value, "value") &&
    hasNonEmptyString(value, "role") &&
    hasNonEmptyStringArray(value, "usage")
  );
}

function isValidCreativeDirectionTypographySystem(
  value: unknown
): value is CreativeDirectionTypographySystem {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasNonEmptyString(value, "heading") &&
    hasNonEmptyString(value, "body") &&
    hasNonEmptyString(value, "navigation") &&
    hasNonEmptyStringArray(value, "scale") &&
    hasNonEmptyStringArray(value, "rules")
  );
}

function isValidCreativeDirectionImageDirection(
  value: unknown
): value is CreativeDirectionImageDirection {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasNonEmptyStringArray(value, "subjects") &&
    hasNonEmptyString(value, "lighting") &&
    hasNonEmptyStringArray(value, "framing") &&
    hasNonEmptyStringArray(value, "avoid")
  );
}

function isValidCreativeDirectionCtaSystem(
  value: unknown
): value is CreativeDirectionCtaSystem {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasNonEmptyString(value, "primary") &&
    hasNonEmptyString(value, "secondary") &&
    hasNonEmptyString(value, "focus") &&
    hasNonEmptyStringArray(value, "rules")
  );
}

function isValidCreativeDirectionMotionMood(
  value: unknown
): value is CreativeDirectionMotionMood {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasNonEmptyStringArray(value, "principles") &&
    hasNonEmptyString(value, "hover") &&
    hasNonEmptyString(value, "transitions") &&
    hasNonEmptyString(value, "reducedMotion")
  );
}

function isValidCreativeDirectionSectionProgression(
  value: unknown
): value is CreativeDirectionSectionProgression {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasNonEmptyString(value, "sectionId") &&
    hasNonEmptyString(value, "visualRole") &&
    hasNonEmptyString(value, "treatment")
  );
}

function isValidCreativeDirectionHandoffToSectionDesign(
  value: unknown
): value is CreativeDirectionHandoffToSectionDesign {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasNonEmptyStringArray(value, "prioritySections") &&
    hasNonEmptyStringArray(value, "layoutQuestions") &&
    hasNonEmptyStringArray(value, "assetRequests") &&
    hasNonEmptyStringArray(value, "risks")
  );
}

export function isValidSectionDesignData(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.sectionDesigns) &&
    value.sectionDesigns.length > 0 &&
    value.sectionDesigns.every(isValidSectionDesignSpec)
  );
}

function isValidSectionDesignSpec(value: unknown): value is SectionDesignSpec {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasNonEmptyString(value, "id") &&
    hasNonEmptyString(value, "storyRole") &&
    hasNonEmptyString(value, "layout") &&
    hasNonEmptyStringArray(value, "elements") &&
    hasNonEmptyStringArray(value, "visualAssets") &&
    hasNonEmptyString(value, "assetPlacement") &&
    hasNonEmptyStringArray(value, "ctas") &&
    hasNonEmptyStringArray(value, "responsiveNotes") &&
    hasNonEmptyStringArray(value, "acceptanceCriteria")
  );
}

export function isValidResponsiveLayoutData(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.responsiveRules) &&
    value.responsiveRules.length > 0 &&
    value.responsiveRules.every(isValidResponsiveRule)
  );
}

function isValidResponsiveRule(value: unknown): value is ResponsiveRule {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasNonEmptyString(value, "viewport") &&
    hasNonEmptyString(value, "layout") &&
    hasNonEmptyString(value, "typography") &&
    hasNonEmptyString(value, "navigation") &&
    hasNonEmptyString(value, "assets") &&
    hasNonEmptyStringArray(value, "constraints")
  );
}

export function isValidInteractionMotionData(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.interactionRules) &&
    value.interactionRules.length > 0 &&
    value.interactionRules.every(isValidInteractionRule)
  );
}

function isValidInteractionRule(value: unknown): value is InteractionRule {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasNonEmptyString(value, "trigger") &&
    hasNonEmptyString(value, "target") &&
    hasNonEmptyString(value, "feedback") &&
    hasNonEmptyString(value, "motion") &&
    hasNonEmptyString(value, "accessibility") &&
    hasNonEmptyString(value, "reducedMotion")
  );
}

export function isValidAccessibilityReviewData(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.accessibilityChecks) &&
    value.accessibilityChecks.length > 0 &&
    value.accessibilityChecks.every(isValidAccessibilityDesignCheck)
  );
}

function isValidAccessibilityDesignCheck(
  value: unknown
): value is AccessibilityDesignCheck {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasNonEmptyString(value, "id") &&
    hasNonEmptyString(value, "target") &&
    hasNonEmptyString(value, "requirement") &&
    hasNonEmptyString(value, "method") &&
    hasNonEmptyString(value, "status") &&
    hasNonEmptyString(value, "fix")
  );
}

export function isValidFinalPolishData(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.polishChecks) &&
    value.polishChecks.length > 0 &&
    value.polishChecks.every(isValidPolishCheck)
  );
}

function isValidPolishCheck(value: unknown): value is PolishCheck {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasNonEmptyString(value, "target") &&
    hasNonEmptyString(value, "criterion") &&
    hasNonEmptyString(value, "status") &&
    hasNonEmptyString(value, "recommendation")
  );
}

function isValidDesignQaStepOutput(value: unknown): value is DesignQaStepOutput {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.passNumber === "number" &&
    isEnumValue(value.status, designQaStepStatuses) &&
    typeof value.inspectedAt === "string" &&
    typeof value.scope === "string" &&
    Array.isArray(value.viewportResults) &&
    value.viewportResults.every(isValidDesignQaViewportResult) &&
    Array.isArray(value.issues) &&
    value.issues.every(isValidDesignQaIssue) &&
    Array.isArray(value.fixPlan) &&
    value.fixPlan.every(isValidDesignQaFixAction) &&
    isStringArray(value.resolvedIssueIds) &&
    isStringArray(value.remainingIssueIds) &&
    typeof value.stopCondition === "string" &&
    isEnumValue(value.nextAction, designQaNextActions)
  );
}

function isCompleteDesignQaStepOutput(value: unknown): boolean {
  return (
    isValidDesignQaStepOutput(value) &&
    value.passNumber > 0 &&
    value.status !== "blocked" &&
    value.scope.trim().length > 0 &&
    value.viewportResults.length > 0 &&
    value.stopCondition.trim().length > 0 &&
    value.nextAction !== "blocked"
  );
}

function isValidDesignCodeGenerationOutput(
  value: unknown
): value is DesignCodeGenerationOutput {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isEnumValue(value.status, designCodeGenerationStatuses) &&
    typeof value.summary === "string" &&
    isStringArray(value.targetFiles) &&
    isStringArray(value.components) &&
    isStringArray(value.assets) &&
    isStringArray(value.constraints) &&
    isStringArray(value.implementationNotes) &&
    isStringArray(value.acceptanceCriteria)
  );
}

function isCompleteDesignCodeGenerationOutput(value: unknown): boolean {
  return (
    isValidDesignCodeGenerationOutput(value) &&
    value.status !== "not-started" &&
    value.summary.trim().length > 0 &&
    value.targetFiles.length > 0 &&
    value.components.length > 0 &&
    value.constraints.length > 0 &&
    value.acceptanceCriteria.length > 0
  );
}

function isValidImplementationQaOutput(
  value: unknown
): value is ImplementationQaOutput {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.passNumber === "number" &&
    isEnumValue(value.status, implementationQaStatuses) &&
    typeof value.inspectedAt === "string" &&
    typeof value.scope === "string" &&
    Array.isArray(value.checks) &&
    value.checks.every(isValidImplementationQaCheck) &&
    Array.isArray(value.issues) &&
    value.issues.every(isValidDesignQaIssue) &&
    Array.isArray(value.fixPlan) &&
    value.fixPlan.every(isValidDesignQaFixAction) &&
    isStringArray(value.resolvedIssueIds) &&
    isStringArray(value.remainingIssueIds) &&
    typeof value.stopCondition === "string" &&
    isEnumValue(value.nextAction, designQaNextActions)
  );
}

function isCompleteImplementationQaOutput(value: unknown): boolean {
  return (
    isValidImplementationQaOutput(value) &&
    value.passNumber > 0 &&
    value.status !== "not-run" &&
    value.status !== "blocked" &&
    value.scope.trim().length > 0 &&
    value.checks.length > 0 &&
    value.stopCondition.trim().length > 0 &&
    value.nextAction !== "blocked"
  );
}

function isValidImplementationQaCheck(value: unknown): value is ImplementationQaCheck {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    isEnumValue(value.kind, implementationQaCheckKinds) &&
    isEnumValue(value.status, designQaViewportStatuses) &&
    typeof value.target === "string" &&
    typeof value.evidence === "string" &&
    typeof value.notes === "string"
  );
}

function isValidDesignQaViewportResult(
  value: unknown
): value is DesignQaViewportResult {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isEnumValue(value.viewport, designQaViewports) &&
    isEnumValue(value.status, designQaViewportStatuses) &&
    typeof value.evidence === "string" &&
    typeof value.notes === "string"
  );
}

function isValidDesignQaIssue(value: unknown): value is DesignQaIssue {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    isEnumValue(value.category, designQaIssueCategories) &&
    isEnumValue(value.severity, designQaSeverities) &&
    typeof value.location === "string" &&
    typeof value.problem === "string" &&
    isEnumValue(value.evidenceKind, designQaEvidenceKinds) &&
    typeof value.evidence === "string" &&
    typeof value.recommendedFix === "string" &&
    isEnumValue(value.status, designQaIssueStatuses)
  );
}

function isValidDesignQaFixAction(value: unknown): value is DesignQaFixAction {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    isStringArray(value.issueIds) &&
    isEnumValue(value.action, designQaFixActionTypes) &&
    typeof value.targetSection === "string" &&
    typeof value.description === "string" &&
    typeof value.expectedOutcome === "string" &&
    typeof value.requiresPatch === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function hasNonEmptyString(
  value: Record<string, unknown>,
  key: string
): value is Record<string, unknown> & Record<typeof key, string> {
  return typeof value[key] === "string" && value[key].trim().length > 0;
}

function hasNonEmptyStringArray(
  value: Record<string, unknown>,
  key: string
): value is Record<string, unknown> & Record<typeof key, readonly string[]> {
  return (
    Array.isArray(value[key]) &&
    value[key].length > 0 &&
    value[key].every((item) => typeof item === "string" && item.trim().length > 0)
  );
}

function isEnumValue<T extends string>(
  value: unknown,
  values: readonly T[]
): value is T {
  return typeof value === "string" && values.includes(value as T);
}
