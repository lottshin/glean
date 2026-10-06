import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'output',
		'promo',
		'extension/dist',
		'docs/player',
		'extension/esbuild.mjs',
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
					allowDefaultProject: [
						'eslint.config.mts',
						'manifest.json',
					'extension/*.mjs',
					'scripts/*.mjs',
					'tools/*.{js,mjs}',
					],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		files: ['extension/src/**/*.ts'],
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.webextensions,
			},
		},
		rules: {
			'no-restricted-globals': 'off',
			'obsidianmd/prefer-create-el': 'off',
			'obsidianmd/ui/sentence-case': 'off',
			'obsidianmd/no-global-this': 'off',
		},
	},
	{
		files: ['extension/*.mjs', 'scripts/*.mjs', 'tools/*.{js,mjs}'],
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
