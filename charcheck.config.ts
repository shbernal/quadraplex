import { defineConfig } from 'charcheck/config'

export default defineConfig({
  rules: [
    {
      id: 'no-em-dash',
      chars: ['—'],
      include: [
        'README.md',
        'CONTRIBUTING.md',
        'CHANGELOG.md',
        'AGENTS.md',
        'docs/**/*.md',
        'skills/**/*.md',
      ],
    },
  ],
})
