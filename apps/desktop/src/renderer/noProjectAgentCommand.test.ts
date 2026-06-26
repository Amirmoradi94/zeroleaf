import { describe, expect, it } from "vitest";

import { parseNoProjectAgentCommand } from "./noProjectAgentCommand.js";

describe("parseNoProjectAgentCommand", () => {
  it("preserves separate project and Word document names from one prompt", () => {
    expect(
      parseNoProjectAgentCommand(
        "Create a blank MS Word project named zeroleaf-phase-six-word-test with document findings.docx"
      )
    ).toEqual({
      kind: "create-project",
      documentKind: "word",
      projectName: "zeroleaf-phase-six-word-test",
      wordPath: "findings.docx"
    });
  });

  it("supports quoted Word document names with spaces", () => {
    expect(
      parseNoProjectAgentCommand(
        'Start a Word document project called field-notes with document "research findings.docx"'
      )
    ).toEqual({
      kind: "create-project",
      documentKind: "word",
      projectName: "field-notes",
      wordPath: "research-findings.docx"
    });
  });

  it("falls back to a project-derived Word path when no filename is supplied", () => {
    expect(
      parseNoProjectAgentCommand("Make a Microsoft Word project named meeting notes")
    ).toEqual({
      kind: "create-project",
      documentKind: "word",
      projectName: "meeting notes",
      wordPath: "meeting-notes.docx"
    });
  });
});
