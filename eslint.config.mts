import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'dev-probe',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
		'vitest.config.ts',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json', 'tools/*.mjs'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		files: ['tools/*.mjs'],
		rules: {
			'no-console': 'off',
			'obsidianmd/rule-custom-message': 'off',
		},
	},
	{
		// Environment-agnostic modules: unit tested under Node, so they cannot
		// reach for `window`.
		files: ['src/translate/*.ts'],
		rules: {
			'obsidianmd/prefer-window-timers': 'off',
		},
	},
);
