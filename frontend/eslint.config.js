import js from "@eslint/js";
import react from "eslint-plugin-react";

export default [
  {
    ignores: ["dist/**", "node_modules/**"]
  },
  js.configs.recommended,
  {
    files: ["src/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: 2024,
      globals: {
        document: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        URLSearchParams: "readonly",
        window: "readonly"
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        },
        sourceType: "module"
      }
    },
    plugins: {
      react
    },
    rules: {
      "react/jsx-uses-vars": "error",
      "react/jsx-uses-react": "off",
      "react/react-in-jsx-scope": "off"
    },
    settings: {
      react: {
        version: "detect"
      }
    }
  }
];
