// Farbschema uebernommen vom Überwachungs-Panel (dark-only)
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        panel: {
          bg: '#0d1117',
          // Tiefer als der Seitenhintergrund, für eingelassene Flächen:
          // Code-Blöcke, Protokollausschnitte, Statuskästen. Sechs Stellen
          // benutzten "panel-darker" bereits, ohne dass es die Farbe gab —
          // Tailwind erzeugt für einen unbekannten Namen schlicht keine Regel,
          // die Flächen blieben also einfach durchsichtig.
          darker: '#010409',
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
