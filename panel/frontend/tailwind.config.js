// Farbschema uebernommen vom Überwachungs-Panel (dark-only)
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        panel: {
          bg: '#0d1117',
          surface: '#161b22',
          card: '#21262d',
          border: '#30363d',
          text: '#e6edf3',
          muted: '#8b949e',
          accent: '#388bfd',
          green: '#3fb950',
          red: '#f85149',
          orange: '#e3b341',
          purple: '#a371f7',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
