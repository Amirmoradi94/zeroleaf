export type CommandId =
  | "open-project"
  | "quick-open"
  | "save-file"
  | "save-all"
  | "find-in-file"
  | "project-search"
  | "compile-project"
  | "open-settings"
  | "toggle-problems"
  | "focus-agent"
  | "fix-top-diagnostic";

export type CommandDefinition = {
  readonly id: CommandId;
  readonly title: string;
  readonly group: string;
  readonly shortcut?: string;
  readonly disabled?: boolean;
};

export const commandDefinitions: readonly CommandDefinition[] = [
  {
    id: "open-project",
    title: "Open Project",
    group: "Project",
    shortcut: "Cmd O"
  },
  {
    id: "quick-open",
    title: "Quick Open File",
    group: "Project",
    shortcut: "Cmd P"
  },
  {
    id: "save-file",
    title: "Save File",
    group: "Editor",
    shortcut: "Cmd S"
  },
  {
    id: "save-all",
    title: "Save All",
    group: "Editor",
    shortcut: "Cmd Shift S"
  },
  {
    id: "find-in-file",
    title: "Find in File",
    group: "Editor",
    shortcut: "Cmd F"
  },
  {
    id: "project-search",
    title: "Search Project",
    group: "Project"
  },
  {
    id: "compile-project",
    title: "Compile Project",
    group: "Compiler",
    shortcut: "Cmd Enter"
  },
  {
    id: "open-settings",
    title: "Open Settings",
    group: "Application",
    shortcut: "Cmd ,"
  },
  {
    id: "toggle-problems",
    title: "Toggle Panels",
    group: "Workbench"
  },
  {
    id: "focus-agent",
    title: "Focus Agent",
    group: "Agent",
    shortcut: "Cmd I"
  },
  {
    id: "fix-top-diagnostic",
    title: "Fix Top Diagnostic with AI",
    group: "Agent"
  }
];
