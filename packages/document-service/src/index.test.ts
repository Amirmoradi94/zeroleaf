import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Document, Packer, Paragraph, TextRun } from "docx";
import { describe, expect, it } from "vitest";

import {
  DocumentServiceError,
  applyWordBlockOperations,
  applyWordChangeSet,
  createWordChangeSet,
  readWordDocument,
  saveWordDocument
} from "./index.js";

describe("document-service", () => {
  it("reads a .docx document into paragraph blocks", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "zeroleaf-docx-read-"));
    const documentPath = join(projectRoot, "paper.docx");
    const buffer = await Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [
              new Paragraph({ children: [new TextRun("Opening paragraph.")] }),
              new Paragraph({ children: [new TextRun("Second paragraph.")] })
            ]
          }
        ]
      })
    );
    await writeFile(documentPath, buffer);

    const document = await readWordDocument(projectRoot, "paper.docx");

    expect(document.path).toBe("paper.docx");
    expect(document.kind).toBe("word");
    expect(document.plainText).toContain("Opening paragraph.");
    expect(document.plainText).toContain("Second paragraph.");
    expect(document.blocks.length).toBeGreaterThanOrEqual(2);
  });

  it("saves paragraph blocks as a readable .docx document", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "zeroleaf-docx-save-"));

    await saveWordDocument(projectRoot, "draft.docx", [
      { id: "p-1", kind: "paragraph", text: "Revised introduction." },
      { id: "p-2", kind: "paragraph", text: "Revised conclusion." }
    ]);

    const saved = await readWordDocument(projectRoot, "draft.docx");

    expect(saved.plainText).toContain("Revised introduction.");
    expect(saved.plainText).toContain("Revised conclusion.");
  });

  it("rejects paths outside the project root", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "zeroleaf-docx-safe-"));

    await expect(
      saveWordDocument(projectRoot, "../outside.docx", [
        { id: "p-1", kind: "paragraph", text: "No outside writes." }
      ])
    ).rejects.toBeInstanceOf(DocumentServiceError);
  });

  it("creates and applies a Word changeset with round-trip verification", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "zeroleaf-docx-changeset-"));
    await saveWordDocument(projectRoot, "paper.docx", [
      { id: "p-1", kind: "paragraph", text: "Original introduction." },
      { id: "p-2", kind: "paragraph", text: "Original conclusion." }
    ]);
    const baseDocument = await readWordDocument(projectRoot, "paper.docx");
    const targetBlock = baseDocument.blocks[0]!;
    const changeset = await createWordChangeSet({
      projectRoot,
      filePath: "paper.docx",
      baseBlocks: baseDocument.blocks,
      operations: [
        {
          type: "replace-block",
          blockId: targetBlock.id,
          afterText: "Revised introduction with clearer scope."
        }
      ],
      summary: "Revise Word introduction"
    });

    const result = await applyWordChangeSet(changeset);

    expect(result.changeset.status).toBe("applied");
    expect(result.document.plainText).toContain(
      "Revised introduction with clearer scope."
    );
  });

  it("applies paragraph insert, selection replace, and delete operations", () => {
    const blocks = [
      { id: "p-1", kind: "paragraph" as const, text: "Alpha beta gamma." },
      { id: "p-2", kind: "paragraph" as const, text: "Remove this paragraph." }
    ];

    const nextBlocks = applyWordBlockOperations(blocks, [
      {
        type: "replace-selection",
        blockId: "p-1",
        startOffset: 6,
        endOffset: 10,
        replacementText: "delta"
      },
      {
        type: "insert-block-after",
        afterBlockId: "p-1",
        block: { id: "p-3", kind: "paragraph", text: "Inserted paragraph." }
      },
      { type: "delete-block", blockId: "p-2" }
    ]);

    expect(nextBlocks.map((block) => block.text)).toEqual([
      "Alpha delta gamma.",
      "Inserted paragraph."
    ]);
  });
});
