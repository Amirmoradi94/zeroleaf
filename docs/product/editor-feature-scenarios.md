# Zeroleaf Editor Feature Scenarios

Date: 2026-06-08

Purpose: list the editor's product feature areas and define five real-world
scenarios under each area. These scenarios are written for product planning,
manual QA, and future E2E automation.

## Feature List

1. Project Dashboard
2. Project and File Management
3. Source Editor
4. PDF Preview and SyncTeX Navigation
5. Build, Logs, and Diagnostics
6. Bibliography and References
7. History, Review, and Versioning
8. AI Provider and Session Management
9. AI Entry Points and Context Attachment
10. AI Writing and Academic Editing
11. AI LaTeX Editing
12. AI Compile Error Repair Loop
13. Project-Wide AI Actions
14. Bibliography AI Actions
15. PDF-Aware AI Actions
16. Agent Review, Diff, Approval, and Safety
17. Settings, Permissions, and Privacy
18. Export, Templates, Import, and Submission Checks

## 14. Bibliography AI Actions

### Scenario 1: Suggest citations for uncited claim

- User: Author writing related work.
- Context: Paragraph makes a claim but has no citation.
- Steps: Ask agent to suggest citations from local `.bib`, review candidates,
  insert selected citation, and compile.
- Expected result: Agent uses existing bibliography keys and does not invent
  sources.
- Edge checks: If no good local source exists, agent asks for source details.

### Scenario 2: Fix a typo in citation key

- User: Author typed `lamprt1994`.
- Context: `.bib` contains `lamport1994`.
- Steps: Run missing citation detector, ask agent to repair likely typo, review
  patch, and compile.
- Expected result: Agent replaces typo with closest valid key.
- Edge checks: Similar keys should be presented for confirmation.

### Scenario 3: Clean malformed BibTeX entry

- User: Researcher pasted a messy BibTeX entry.
- Context: Entry has bad capitalization and invalid characters.
- Steps: Ask agent to clean entry, review `.bib` diff, and compile.
- Expected result: BibTeX remains valid and important title capitalization is
  preserved with braces.
- Edge checks: Agent should not remove DOI or URL fields without reason.

### Scenario 4: Adapt citation commands to style

- User: Journal template uses `natbib`.
- Context: Draft contains `\textcite`, which is unsupported.
- Steps: Ask agent to adapt citations to `natbib`, review patch, and compile.
- Expected result: Commands become compatible with project packages.
- Edge checks: Agent should inspect preamble before changing citation style.

### Scenario 5: Explain unused references

- User: Author deciding whether to prune bibliography.
- Context: Reference panel lists unused entries.
- Steps: Ask agent whether unused entries are related to manuscript topics,
  decide to cite or remove, and apply approved changes.
- Expected result: Agent provides context-aware cleanup suggestions.
- Edge checks: Removal should be patch-first and reversible.

## 15. PDF-Aware AI Actions

### Scenario 1: Fix overfull hbox

- User: Author sees overfull warning.
- Context: Long URL or equation spills past margin.
- Steps: Ask agent to inspect warning and source, propose line break or layout
  fix, approve, and recompile.
- Expected result: Warning is reduced or explained, and rendered PDF improves.
- Edge checks: Agent should not hide warnings by suppressing them globally.

### Scenario 2: Improve table layout

- User: Researcher has a table extending beyond page width.
- Context: PDF preview shows clipped columns.
- Steps: Ask agent to adjust table width/alignment, review patch, compile, and
  inspect PDF.
- Expected result: Table fits page while preserving data.
- Edge checks: Numeric values should not be altered.

### Scenario 3: Diagnose missing figure in PDF

- User: Author expects a figure but sees blank/missing output.
- Context: Source references `figures/model.png`.
- Steps: Ask agent why figure is missing, inspect file tree and log, apply path
  fix if needed, and compile.
- Expected result: Agent identifies missing asset, wrong path, or unsupported
  format.
- Edge checks: Agent cannot fetch images from network without approval.

## 16. Agent Review, Diff, Approval, and Safety

### Scenario 1: Approve a low-risk patch

- User: Author accepts a missing `\end{document}` fix.
- Context: Agent proposes one-line patch.
- Steps: Review diff, approve apply-patch, let agent compile, and inspect final
  status.
- Expected result: Patch is applied only after approval and verification is
  visible.
- Edge checks: Approval ID is tied to the exact requested action.

### Scenario 2: Block outside-root write

- User: Security tester prompts agent to write outside project.
- Context: Prompt asks to create `/tmp/notes.txt` or modify another project.
- Steps: Run in any mode, observe tool request or block, and inspect audit log.
- Expected result: Outside-root write is blocked by default.
- Edge checks: User must explicitly grant expanded context before any exception.

### Scenario 3: Deny network access

- User: Author working on confidential manuscript.
- Context: Agent asks to fetch DOI metadata or web content.
- Steps: Deny network approval and ask for local-only alternative.
- Expected result: Agent continues with local files or asks user to paste data.
- Edge checks: Denied network request is recorded.

### Scenario 4: Limit autonomous loop

- User: Power user tries autonomous local repair.
- Context: Project has several warnings and one error.
- Steps: Set max turns/compile attempts, start repair, and observe stop at limit
  or success.
- Expected result: Agent cannot run indefinitely.
- Edge checks: Timeouts and cancellation leave files consistent.

### Scenario 5: Explain a proposed change

- User: Author is unsure why agent changed a package.
- Context: Diff adds `\usepackage{booktabs}`.
- Steps: Ask agent to explain that hunk, review answer, approve or reject.
- Expected result: Agent can justify changes based on source/log context.
- Edge checks: Explanation should not apply new edits without approval.

## 18. Export, Templates, Import, and Submission Checks

### Scenario 5: Run submission bundle check

- User: Author preparing arXiv upload.
- Context: Project has generated `.aux`, `.log`, and `.bbl` files in source
  tree.
- Steps: Run submission check, review warnings, remove generated files from
  source bundle, export ZIP, and compile imported ZIP.
- Expected result: Submission check identifies generated artifacts and missing
  source issues before upload.
- Edge checks: Warnings are separated from blocking errors.
