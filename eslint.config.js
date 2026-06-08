import js from "@eslint/js";

export default [
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      ".claude/**",
      "tmp/**",
      "release/**",
      "scripts/private-alpha-readiness.mjs"
    ]
  },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        __dirname: "readonly",
        console: "readonly",
        clearTimeout: "readonly",
        module: "readonly",
        process: "readonly",
        require: "readonly",
        setTimeout: "readonly",
        URL: "readonly"
      }
    }
  }
];
